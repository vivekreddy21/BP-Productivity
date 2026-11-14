/**
 * Brain Points — Screen Time logger (Google Apps Script backend, module 1)
 *
 * iPhone Shortcuts automations call this web app when an entertainment app
 * opens or closes. Events land in the "events" sheet; this script turns them
 * into sessions, daily minutes, and a brain-point penalty.
 *
 * Endpoints (all GET, so Shortcuts and the Garmin watch can both call them):
 *   ?key=SECRET&action=log&app=youtube&event=open     -> logs an event
 *   ?key=SECRET&action=log&app=youtube&event=close    -> logs an event
 *   ?key=SECRET&action=today                          -> today's totals (JSON)
 *   ?key=SECRET&action=day&date=2026-10-31            -> any day's totals (JSON)
 *
 * Planner endpoints (see Planner.gs / Scheduler.gs):
 *   ?key=SECRET&action=replan                         -> re-plan the rest of today from now (text)
 *   ?key=SECRET&action=plan[&date=YYYY-MM-DD]         -> day plan (JSON, for the watch)
 *   ?key=SECRET&action=complete&id=T2                 -> finish a whole task, clear its later blocks (JSON)
 *   ?key=SECRET&action=done&n=3                       -> mark today's block #3 done (JSON)
 *   ?key=SECRET&action=addtask&name=Essay&deadline=2026-11-05&impact=4&hours=3&difficulty=2
 *                                                     -> add a task; re-plans the rest of today (text)
 *   ?key=SECRET&action=tasks                          -> open tasks, most important first (text)
 *   ?key=SECRET&action=view                           -> phone dashboard (HTML, see View.gs)
 *   ?key=SECRET&action=face                           -> tiny JSON for the Garmin watch face
 */

// ---------- Settings (edit these) ----------
const CONFIG = {
  BUDGET_MIN: 60,          // daily entertainment allowance, minutes
  PENALTY_BLOCK_MIN: 15,   // every started block of this many minutes over budget...
  PENALTY_PER_BLOCK: 3,    // ...costs this many brain points
  SESSION_CAP_MIN: 45,     // a session with no "close" event is counted as at most this long
  MIN_SESSION_SEC: 5,      // ignore blips shorter than this (app opened by accident)
};
// The secret key is stored in Script Properties (see setup()), not in code.

// ---------- Web app entry point ----------
function doGet(e) {
  const p = (e && e.parameter) || {};
  const secret = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!secret || p.key !== secret) return json_({ ok: false, error: 'bad key' });

  try {
    // Screen time
    if (p.action === 'log') return json_(logEvent_(p.app, p.event));
    if (p.action === 'today') return json_(daySummary_(todayStr_()));
    if (p.action === 'day') return json_(daySummary_(p.date));
    // Planner (text replies are for iPhone Shortcuts; JSON is for the watch)
    if (p.action === 'checkinlist' || p.action === 'checkin') {
      return text_('The morning check-in was retired. Tick tasks off on the Today page instead - your day starts automatically.');
    }
    if (p.action === 'replan') return text_(planText_(withLock_(replan_)));
    if (p.action === 'tasks') return text_(tasksText_());
    if (p.action === 'view') return dashboardPage_(p.key);
    if (p.action === 'addtask') return text_(withLock_(function () { return addTask_(p); }));
    if (p.action === 'plan') return json_(planJson_(p.date));
    if (p.action === 'face') return json_(faceJson_());
    if (p.action === 'complete') return json_(withLock_(function () { return completeTask_(p.id); }));
    if (p.action === 'done') return json_(withLock_(function () { return markDone_(p.n, p.date); }));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return ['checkin', 'replan', 'checkinlist', 'addtask', 'tasks'].indexOf(p.action) >= 0
      ? text_('Error: ' + (err && err.message ? err.message : err))
      : json_({ ok: false, error: String(err) });
  }
}

// ---------- Logging ----------
function logEvent_(app, event) {
  app = String(app || '').trim().toLowerCase();
  event = String(event || '').trim().toLowerCase();
  if (!app) throw new Error('missing app');
  if (event !== 'open' && event !== 'close') throw new Error('event must be open or close');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // open+close can arrive together, or while a check-in is running
  try {
    const now = new Date();
    sheet_('events', ['timestamp', 'app', 'event']).appendRow([now, app, event]);
    return { ok: true, logged: { app: app, event: event, at: now.toISOString() } };
  } finally {
    lock.releaseLock();
  }
}

// ---------- Summaries ----------
function daySummary_(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) throw new Error('date must be YYYY-MM-DD');
  const tz = Session.getScriptTimeZone();
  const dayStart = Utilities.parseDate(dateStr + ' 00:00:00', tz, 'yyyy-MM-dd HH:mm:ss').getTime();
  const dayEnd = dayStart + 24 * 3600 * 1000;

  // Read a window slightly wider than the day so sessions crossing midnight count correctly.
  const rows = sheet_('events', ['timestamp', 'app', 'event']).getDataRange().getValues().slice(1);
  const windowMs = CONFIG.SESSION_CAP_MIN * 60 * 1000;
  const events = rows
    .map(function (r) { return { t: new Date(r[0]).getTime(), app: String(r[1]), event: String(r[2]) }; })
    .filter(function (ev) { return ev.t >= dayStart - windowMs && ev.t < dayEnd + windowMs; });

  const sessions = buildSessions(events, CONFIG, Date.now());
  return summarize(sessions, dayStart, dayEnd, CONFIG, dateStr);
}

/** Nightly job: write yesterday's totals to the "daily" sheet (history for the scoring engine). */
function nightlyRollup() {
  const tz = Session.getScriptTimeZone();
  const y = new Date(Date.now() - 24 * 3600 * 1000);
  const dateStr = Utilities.formatDate(y, tz, 'yyyy-MM-dd');
  const s = daySummary_(dateStr);
  sheet_('daily', ['date', 'minutes', 'budget', 'over_min', 'penalty_bp', 'by_app_json'])
    .appendRow([dateStr, s.minutes, s.budget, s.overMinutes, s.penaltyBP, JSON.stringify(s.byApp)]);
}

// ---------- Pure logic (no Google services; unit-tested) ----------

/**
 * Turn a list of {t, app, event} into sessions {app, start, end}.
 * Rules:
 *  - An "open" starts a session for that app.
 *  - The session ends at the next "close" for that app, OR at the next "open" of any app
 *    (you can only be in one app at a time), whichever comes first.
 *  - If nothing ends it, it is capped at SESSION_CAP_MIN (or "now" if still running).
 *  - A "close" with no matching open is ignored.
 */
function buildSessions(events, cfg, nowMs) {
  const evs = events.slice().sort(function (a, b) { return a.t - b.t; });
  const capMs = cfg.SESSION_CAP_MIN * 60 * 1000;
  const sessions = [];
  let open = null; // {app, start}

  // A real "close" ends the session exactly; inferred ends (next app opened, or nothing) are capped.
  function closeAt(t, inferred) {
    const end = inferred ? Math.min(t, open.start + capMs) : t;
    if (end - open.start >= cfg.MIN_SESSION_SEC * 1000) {
      sessions.push({ app: open.app, start: open.start, end: end });
    }
    open = null;
  }

  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (ev.event === 'open') {
      if (open) closeAt(ev.t, true);
      open = { app: ev.app, start: ev.t };
    } else if (ev.event === 'close' && open && open.app === ev.app) {
      closeAt(ev.t, false);
    }
  }
  if (open) closeAt(nowMs, true);
  return sessions;
}

/** Clip sessions to [dayStart, dayEnd) and compute minutes, per-app split, and penalty. */
function summarize(sessions, dayStart, dayEnd, cfg, dateStr) {
  const byAppMs = {};
  let totalMs = 0;
  sessions.forEach(function (s) {
    const ms = Math.max(0, Math.min(s.end, dayEnd) - Math.max(s.start, dayStart));
    if (ms > 0) {
      byAppMs[s.app] = (byAppMs[s.app] || 0) + ms;
      totalMs += ms;
    }
  });
  const minutes = Math.round(totalMs / 60000);
  const over = Math.max(0, minutes - cfg.BUDGET_MIN);
  const blocks = Math.ceil(over / cfg.PENALTY_BLOCK_MIN);
  const byApp = {};
  Object.keys(byAppMs).forEach(function (k) { byApp[k] = Math.round(byAppMs[k] / 60000); });
  return {
    ok: true,
    date: dateStr,
    minutes: minutes,
    budget: cfg.BUDGET_MIN,
    remaining: Math.max(0, cfg.BUDGET_MIN - minutes),
    overMinutes: over,
    penaltyBP: blocks * cfg.PENALTY_PER_BLOCK,
    byApp: byApp,
  };
}

// ---------- One-time setup (run this once from the editor) ----------
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KEY')) {
    props.setProperty('KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  }
  sheet_('events', ['timestamp', 'app', 'event']);
  sheet_('daily', ['date', 'minutes', 'budget', 'over_min', 'penalty_bp', 'by_app_json']);

  // Planner sheets, seeded the first time only with EXAMPLE rows. Replace the 'fixed' tab
  // (or these rows) with your own schedule.
  sheet_('settings', ['key', 'value', 'note'], SETTINGS_DEFAULTS, [2]);
  sheet_('fixed', FIXED_HEADERS, [
    ['Breakfast', 'Daily', '07:45', '08:30', 'meal', 0],
    ['Lunch', 'Daily', '12:15', '13:00', 'meal', 0],
    ['Dinner', 'Daily', '18:45', '19:30', 'meal', 0],
    ['Morning Lecture', 'Mon,Wed,Fri', '10:00', '10:50', 'class', 15],
    ['Seminar', 'Tue,Thu', '09:30', '10:45', 'class', 15],
    ['Lab Section', 'Wed', '14:00', '16:00', 'class', 20],
    ['Team Meeting', 'Mon', '15:00', '16:00', 'meeting', 10],
    ['Office Hours', 'Thu', '13:30', '14:30', 'meeting', 5],
    ['Workout', 'Mon,Wed,Fri', '17:30', '18:15', 'workout', 0],
    ['Guitar', 'Daily', '19:30', '20:00', 'hobby', 0],
    ['Reading', 'Daily', '22:00', '22:30', 'hobby', 0],
  ], [3, 4]);
  sheet_('tasks', TASK_HEADERS, [
    ['', 'EXAMPLE - delete me', addDaysStr_(todayStr_(), 5), 4, 3, 2, '', 'open'],
  ], [1]);
  sheet_('plan', PLAN_HEADERS, null, [1, 3, 4, 10]);
  sheet_('checkins', CHECKIN_HEADERS, null, [1, 2]);

  // Triggers (remove old copies first so nothing runs twice).
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['nightlyRollup', 'nightly', 'autoCheckin'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('nightly').timeBased().everyDays(1).atHour(0).nearMinute(5).create();

  cal_(settings_()); // creates the "Brain Points" calendar if it doesn't exist
  Logger.log('Your secret key: ' + props.getProperty('KEY'));
}

// ---------- Helpers ----------
/** Get a sheet, creating it (headers, optional seed rows, plain-text columns) if missing. */
function sheet_(name, headers, seedRows, textCols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    // Plain-text columns stop Sheets from turning "07:00" or "2026-11-01" into date/time values.
    (textCols || []).forEach(function (c) { sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@'); });
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    (seedRows || []).forEach(function (r) { sh.appendRow(r); });
  }
  return sh;
}

function text_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Lets the Node unit tests import the pure functions; ignored by Apps Script.
if (typeof module !== 'undefined') module.exports = { buildSessions: buildSessions, summarize: summarize };
