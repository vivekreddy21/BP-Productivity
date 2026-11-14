/**
 * Brain Points — planner glue: Sheets in, Google Calendar out.
 *
 * Sheets you edit:   settings, fixed (weekly blocks), tasks
 * Sheets it writes:  plan (one row per block, with a "done" checkbox), checkins (daily scores)
 */

const PLAN_HEADERS = ['date', '#', 'start', 'end', 'kind', 'name', 'task_id', 'bp', 'done', 'event_id'];
const TASK_HEADERS = ['id', 'task', 'deadline', 'impact (1-5)', 'hours', 'difficulty (1-3)', 'hours_left', 'status'];
const FIXED_HEADERS = ['name', 'days', 'start', 'end', 'type', 'bp'];
// One row per day ("checkins" tab name kept for compatibility). Column 10 is the day's starting BP.
const CHECKIN_HEADERS = ['date', 'reviewed_day', 'score_pct', 'planned_bp', 'done_bp', 'carry_bp', 'overdue', '', '', 'start_bp'];
const SETTINGS_DEFAULTS = [
  ['wake_time', '07:30', 'Strict wake time. Also set this as a recurring alarm on your watch.'],
  ['bed_time', '23:30', 'Lights out. Must be before midnight.'],
  ['wind_down_min', 30, 'Screens-off buffer before lights out (no tasks scheduled here).'],
  ['min_block_min', 25, 'Shortest task block worth scheduling.'],
  ['max_block_min', 90, 'Longest focus block before a break.'],
  ['break_min', 10, 'Break after each task block.'],
  ['max_task_min_per_day', 180, 'Most time one task can take in a day.'],
  ['bp_per_hour_per_difficulty', 10, 'Task block cost = hours x difficulty x this.'],
  ['base_bp', 100, 'Brain points every morning starts from.'],
  ['baseline_bp', 20, 'BP drained steadily from wake to bed, on top of block costs.'],
  ['reserve_bp', 10, 'BP the planner leaves unscheduled, so a full day ends around this at bedtime.'],
  ['bp_floor', 50, 'Morning brain points never start below this.'],
  ['stress_factor', 0.5, "Share of yesterday's unfinished task BP taken off this morning's start."],
  ['overdue_bp', 5, "Extra off this morning's start per overdue task."],
  ['calendar_name', 'Brain Points', 'Google Calendar the plan is written to.'],
  ['water_every_min', 0, 'Water reminder every N minutes while awake, e.g. 120 (0 = off).'],
];

// ---------- Settings & date helpers ----------
function settings_() {
  const rows = sheet_('settings', ['key', 'value', 'note']).getDataRange().getDisplayValues().slice(1);
  const s = {};
  SETTINGS_DEFAULTS.forEach(function (d) { s[d[0]] = d[1]; });
  rows.forEach(function (r) {
    const k = String(r[0]).trim();
    if (k && String(r[1]).trim() !== '') s[k] = String(r[1]).trim();
  });
  SETTINGS_DEFAULTS.forEach(function (d) {
    if (typeof d[1] === 'number') {
      const n = parseFloat(s[d[0]]);
      s[d[0]] = isNaN(n) ? d[1] : n;
    }
  });
  s.wake = parseHM(s.wake_time); if (s.wake == null) s.wake = 7 * 60;
  s.bed = parseHM(s.bed_time); if (s.bed == null || s.bed <= s.wake) s.bed = 23 * 60;
  return s;
}

function tz_() { return Session.getScriptTimeZone(); }
function ymd_(ds) { return ds.split('-').map(Number); }
function dayNum_(ds) { const p = ymd_(ds); return Math.floor(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000); }
function dow_(ds) { return new Date(dayNum_(ds) * 86400000).getUTCDay(); }
function addDaysStr_(ds, n) { return new Date((dayNum_(ds) + n) * 86400000).toISOString().slice(0, 10); }
function at_(ds, min) {
  return Utilities.parseDate(ds + ' ' + fmtHM(Math.max(0, Math.min(1439, min))), tz_(), 'yyyy-MM-dd HH:mm');
}
function nowMin_() { return parseHM(Utilities.formatDate(new Date(), tz_(), 'HH:mm')); }
function roundUp5_(m) { return Math.ceil(m / 5) * 5; }

// ---------- Sheet I/O ----------
function readPlan_() {
  const vals = sheet_('plan', PLAN_HEADERS).getDataRange().getDisplayValues().slice(1);
  return vals.filter(function (r) { return r[0]; }).map(function (r) {
    return {
      date: String(r[0]), n: +r[1], start: parseHM(r[2]), end: parseHM(r[3]), kind: String(r[4]),
      name: String(r[5]), taskId: String(r[6]), bp: parseFloat(r[7]) || 0,
      done: String(r[8]).toUpperCase() === 'TRUE', eventId: String(r[9] || ''),
    };
  });
}

function writePlan_(rows) {
  const sh = sheet_('plan', PLAN_HEADERS);
  const W = PLAN_HEADERS.length;
  rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start; });
  const last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, W).clearDataValidations();
    sh.getRange(2, 1, last - 1, W).clearContent();
  }
  if (!rows.length) return;
  sh.getRange(2, 9, rows.length, 1).insertCheckboxes(); // must come before setValues (it resets to unchecked)
  sh.getRange(2, 1, rows.length, W).setValues(rows.map(function (r) {
    return [r.date, r.n, fmtHM(r.start), fmtHM(r.end), r.kind, r.name, r.taskId || '', r.bp, !!r.done, r.eventId || ''];
  }));
}

function nextN_(rows, ds) {
  let n = 0;
  rows.forEach(function (r) { if (r.date === ds && r.n > n) n = r.n; });
  return n + 1;
}

function fixedRows_() {
  const vals = sheet_('fixed', FIXED_HEADERS).getDataRange().getDisplayValues().slice(1);
  return vals.filter(function (r) { return String(r[0]).trim(); }).map(function (r) {
    let type = String(r[4] || '').trim().toLowerCase() || 'other';
    if (type === 'task' || type === 'marker') type = 'other';
    return { name: String(r[0]).trim(), days: r[1], start: parseHM(r[2]), end: parseHM(r[3]), type: type, bp: parseFloat(r[5]) || 0 };
  }).filter(function (f) { return f.start != null && f.end != null && f.end > f.start; });
}

function readTasks_() {
  const sh = sheet_('tasks', TASK_HEADERS);
  const vals = sh.getDataRange().getValues();
  let maxId = 0;
  vals.slice(1).forEach(function (r) { const m = String(r[0]).match(/^T(\d+)$/i); if (m) maxId = Math.max(maxId, +m[1]); });
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (!String(r[1]).trim()) continue;
    if (!String(r[0]).trim()) { r[0] = 'T' + (++maxId); sh.getRange(i + 1, 1).setValue(r[0]); }
    const hours = parseFloat(r[4]) || 1;
    let left = (r[6] === '' || r[6] == null) ? hours : parseFloat(r[6]);
    if (isNaN(left)) left = hours;
    out.push({
      row: i + 1, id: String(r[0]).trim(), name: String(r[1]).trim(), deadlineDay: deadlineDay_(r[2]),
      impact: clamp_(parseFloat(r[3]) || 3, 1, 5), difficulty: clamp_(parseFloat(r[5]) || 2, 1, 3),
      hoursLeft: left, status: String(r[7] || '').trim().toLowerCase() || 'open',
    });
  }
  return out;
}

function deadlineDay_(v) {
  if (v instanceof Date && !isNaN(v)) return dayNum_(Utilities.formatDate(v, tz_(), 'yyyy-MM-dd'));
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return dayNum_(m[0]);
  const d = new Date(s);
  return isNaN(d) ? null : dayNum_(Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'));
}

function clamp_(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function findCheckin_(ds) {
  const rows = sheet_('checkins', CHECKIN_HEADERS).getDataRange().getDisplayValues().slice(1);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] === ds) {
      return { date: ds, scorePct: rows[i][2], bp: parseFloat(rows[i][9]) || 0, carryBP: parseFloat(rows[i][5]) || 0 };
    }
  }
  return null;
}

// ---------- Calendar ----------
function cal_(s) {
  const found = CalendarApp.getCalendarsByName(s.calendar_name);
  return found.length ? found[0] : CalendarApp.createCalendar(s.calendar_name);
}

function eventTitle_(r) {
  if (r.kind === 'task') return r.name + ' [' + r.bp + ' BP]';
  return r.name;
}

function makeEvent_(cal, r) {
  const end = r.end > r.start ? r.end : r.start + 5;
  const ev = cal.createEvent(eventTitle_(r), at_(r.date, r.start), at_(r.date, end),
    { description: 'Brain Points block #' + r.n + ' (' + r.kind + ')' });
  try { ev.removeAllReminders(); ev.addPopupReminder(0); }
  catch (e) { try { ev.addPopupReminder(5); } catch (e2) { /* keep calendar default */ } }
  return ev.getId();
}

function deleteEvent_(cal, id) {
  if (!id) return;
  try { const ev = cal.getEventById(id); if (ev) ev.deleteEvent(); } catch (e) { /* already gone */ }
}

// ---------- Building a day ----------
/** (Re)create the non-task blocks for a day: fixed schedule + check-in / wind-down / lights-out markers. */
function buildFixedDay_(ds, s) {
  s = s || settings_();
  const cal = cal_(s);
  const keep = [], drop = [];
  readPlan_().forEach(function (r) { (r.date === ds && r.kind !== 'task' ? drop : keep).push(r); });
  const wasDone = {};
  drop.forEach(function (r) { wasDone[r.name + '|' + r.start] = r.done; deleteEvent_(cal, r.eventId); });

  let n = nextN_(keep, ds);
  const dow = dow_(ds);
  const fresh = [];
  fixedRows_().forEach(function (f) {
    if (daysMatch(f.days, dow)) fresh.push({ date: ds, n: n++, start: f.start, end: f.end, kind: f.type, name: f.name, bp: f.bp });
  });
  fresh.push({ date: ds, n: n++, start: s.wake, end: s.wake + 5, kind: 'marker', name: 'Wake up', bp: 0 });
  fresh.push({ date: ds, n: n++, start: s.bed - s.wind_down_min, end: s.bed, kind: 'marker', name: 'Wind down - screens off', bp: 0 });
  fresh.push({ date: ds, n: n++, start: s.bed, end: Math.min(s.bed + 5, 1439), kind: 'marker', name: 'Lights out', bp: 0 });
  // Water reminders: zero-length rows (they never block task time); hidden from the dashboard and watch face.
  if (s.water_every_min >= 30) {
    for (let t = s.wake + 60; t < s.bed - s.wind_down_min; t += s.water_every_min) {
      fresh.push({ date: ds, n: n++, start: t, end: t, kind: 'water', name: 'Drink water', bp: 0 });
    }
  }
  fresh.forEach(function (r) {
    r.done = !!wasDone[r.name + '|' + r.start];
    r.eventId = makeEvent_(cal, r);
  });
  writePlan_(keep.concat(fresh));
}

/** Plan task blocks for a day from `fromMin` onward, within a total brain-point budget `bp`. */
function planTasksForDay_(ds, fromMin, bp, s) {
  const cal = cal_(s);
  const keep = [], drop = [];
  readPlan_().forEach(function (r) {
    (r.date === ds && r.kind === 'task' && r.start >= fromMin && !r.done ? drop : keep).push(r);
  });
  drop.forEach(function (r) { deleteEvent_(cal, r.eventId); });

  const day = keep.filter(function (r) { return r.date === ds; });
  const busy = day.map(function (r) { return { start: r.start, end: r.end }; });
  const free = freeIntervals(Math.max(s.wake, roundUp5_(fromMin)), s.bed - s.wind_down_min, busy);

  // Budget = starting BP minus the steady baseline drain minus every block already on the day.
  // Done task blocks were already taken off hours_left when ticked; a block in progress right now
  // is about to cover its minutes, so don't schedule that work twice.
  let spent = 0;
  const keptMin = {};
  day.forEach(function (r) {
    spent += r.bp;
    if (r.kind === 'task' && !r.done && r.end > fromMin) keptMin[r.taskId] = (keptMin[r.taskId] || 0) + (r.end - r.start);
  });
  const budget = Math.max(0, bp - (s.baseline_bp || 0) - (s.reserve_bp || 0) - spent);

  const tasks = readTasks_().filter(function (t) { return t.status === 'open'; }).map(function (t) {
    return { id: t.id, name: t.name, deadlineDay: t.deadlineDay, impact: t.impact, difficulty: t.difficulty,
      minutesLeft: Math.max(0, Math.round(t.hoursLeft * 60) - (keptMin[t.id] || 0)) };
  });
  const res = planTasks({ free: free, tasks: tasks, today: dayNum_(ds), budgetBP: budget, settings: s });

  let n = nextN_(keep, ds);
  const fresh = res.blocks.map(function (b) {
    return { date: ds, n: n++, start: b.start, end: b.end, kind: 'task', name: b.name, taskId: b.taskId, bp: b.bp, done: false };
  });
  fresh.forEach(function (r) { r.eventId = makeEvent_(cal, r); });
  writePlan_(keep.concat(fresh));
  return { bp: bp, budget: budget, blocks: fresh, bpLeft: res.bpLeft, atRisk: res.atRisk, unscheduled: res.unscheduled };
}


// ---------- Day start (replaces the old morning check-in) ----------
/**
 * Make sure a day is set up: starting brain points (100 minus yesterday's unfinished-task carry-over),
 * fixed blocks, and planned tasks. Safe to call any number of times; only does work the first time.
 */
function ensureDay_(ds, s) {
  s = s || settings_();
  const existing = findCheckin_(ds);
  if (existing) return existing;
  const yday = addDaysStr_(ds, -1);
  const yRows = readPlan_().filter(function (r) { return r.date === yday; });
  const todayN = dayNum_(ds);
  const overdue = readTasks_().filter(function (t) {
    return t.status === 'open' && t.deadlineDay != null && t.deadlineDay < todayN;
  }).length;
  const c = dayCarry(yRows, overdue, s);
  sheet_('checkins', CHECKIN_HEADERS).appendRow([ds, yday, c.scorePct == null ? '' : c.scorePct,
    c.plannedBP, c.doneBP, c.carryBP, overdue, '', '', c.startBP]);
  if (!readPlan_().some(function (r) { return r.date === ds && r.kind !== 'task'; })) buildFixedDay_(ds, s);
  planTasksForDay_(ds, ds === todayStr_() ? nowMin_() : 0, c.startBP, s);
  return { date: ds, scorePct: c.scorePct, bp: c.startBP, carryBP: c.carryBP };
}

function dayOrStart_(ds) {
  return findCheckin_(ds) || withLock_(function () { return ensureDay_(ds); });
}

/** Live brain points for a day: start, now, projected end-of-day, and a 30-min curve for the watch. */
function bpStatus_(ds, s) {
  s = s || settings_();
  const c = dayOrStart_(ds);
  const blocks = readPlan_().filter(function (r) { return r.date === ds; });
  const now = nowMin_();
  return {
    start: c.bp, carry: c.carryBP || 0, yesterdayPct: c.scorePct,
    now: bpAt(now, c.bp, blocks, s), end: bpAt(s.bed, c.bp, blocks, s),
    curve: bpCurve(c.bp, blocks, s, 30),
  };
}

function planText_(p) {
  const lines = [];
  const used = p.blocks.reduce(function (a, b) { return a + b.bp; }, 0);
  lines.push(p.blocks.length + ' task block(s), ' + used + ' BP, ' +
    (p.bpLeft >= 0 ? p.bpLeft + ' BP spare' : 'OVER budget by ' + (-p.bpLeft) + ' BP (deadline work)'));
  p.blocks.forEach(function (b) { lines.push(fmtHM(b.start) + '-' + fmtHM(b.end) + ' ' + b.name); });
  if (p.atRisk.length) lines.push('AT RISK (due soon, not fully scheduled): ' + p.atRisk.join(', '));
  return lines.join('\n');
}

function replan_() {
  const s = settings_();
  const today = todayStr_();
  const c = ensureDay_(today, s);
  return planTasksForDay_(today, nowMin_() + 5, c.bp, s);
}

/** Add a task from a Shortcut; the rest of today is re-planned to fit it in. */
function addTask_(p) {
  const name = String(p.name || '').trim();
  if (!name) throw new Error('missing name');
  const num = function (v, d, lo, hi) { const n = parseFloat(v); return isNaN(n) ? d : clamp_(n, lo, hi); };
  const deadline = String(p.deadline || '').trim().slice(0, 10);
  sheet_('tasks', TASK_HEADERS).appendRow(['', name, deadline,
    num(p.impact, 3, 1, 5), num(p.hours, 1, 0.25, 100), num(p.difficulty, 2, 1, 3), '', 'open']);
  const t = readTasks_().filter(function (x) { return x.name === name; }).pop(); // assigns the id
  return 'Added ' + t.id + ': ' + name + (deadline ? ' (due ' + deadline + ')' : '') +
    '\n\nRe-planned the rest of today:\n' + planText_(replan_());
}

/** Readable list of open tasks, most important first (for a Safari bookmark / Shortcut). */
/** Open tasks, most important first (due-today/overdue on top). */
function openTasksSorted_(today) {
  const all = readTasks_();
  const open = all.filter(function (t) { return t.status === 'open'; })
    .map(function (t) { return Object.assign(t, { prio: taskPriority(t, today), must: t.deadlineDay != null && t.deadlineDay <= today }); })
    .sort(function (a, b) { return (b.must - a.must) || (b.prio - a.prio); });
  return { open: open, closedCount: all.length - open.length };
}

function dueLabel_(d, today) {
  if (d == null) return 'no deadline';
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const diff = d - today;
  const dt = new Date(d * 86400000);
  const label = WD[dt.getUTCDay()] + ' ' + (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate();
  if (diff < 0) return 'OVERDUE ' + (-diff) + 'd (' + label + ')';
  if (diff === 0) return 'DUE TODAY';
  if (diff === 1) return 'due tomorrow (' + label + ')';
  return 'due in ' + diff + 'd (' + label + ')';
}

function tasksText_() {
  const today = dayNum_(todayStr_());
  const r = openTasksSorted_(today);
  const open = r.open, all = { length: r.open.length + r.closedCount };
  const due = function (d) { return dueLabel_(d, today); };
  const lines = ['OPEN TASKS: ' + open.length + ' (most important first)', ''];
  open.forEach(function (t, i) {
    lines.push((i + 1) + '. ' + t.name + ' [' + t.id + ']');
    lines.push('   ' + due(t.deadlineDay) + ' | ' + (Math.round(t.hoursLeft * 10) / 10) + 'h left | impact ' + t.impact + ', difficulty ' + t.difficulty);
  });
  const done = all.length - open.length;
  if (done) lines.push('', 'Finished or dropped: ' + done);
  return lines.join('\n');
}

/**
 * Tick (or untick) a block. For task blocks this immediately updates the task's hours_left;
 * when a task reaches 0 hours it's marked done and its remaining blocks today are removed.
 */
function markDone_(n, ds, value) {
  ds = ds || todayStr_();
  let all = readPlan_();
  const r = all.filter(function (x) { return x.date === ds && x.n === Number(n); })[0];
  if (!r) throw new Error('no block #' + n + ' on ' + ds);
  const was = r.done;
  r.done = value === undefined ? true : !!value;
  let removed = 0;

  if (r.kind === 'task' && was !== r.done) {
    const t = readTasks_().filter(function (x) { return x.id === r.taskId; })[0];
    if (t) {
      const left = Math.max(0, t.hoursLeft + (r.done ? -1 : 1) * (r.end - r.start) / 60);
      const tsh = sheet_('tasks', TASK_HEADERS);
      tsh.getRange(t.row, 7).setValue(Math.round(left * 100) / 100);
      if (left <= 0.01 && t.status === 'open') {
        tsh.getRange(t.row, 8).setValue('done');
        const cal = cal_(settings_());
        all = all.filter(function (x) {
          const extra = x.date === ds && x.kind === 'task' && x.taskId === r.taskId && !x.done && x !== r;
          if (extra) { deleteEvent_(cal, x.eventId); removed++; }
          return !extra;
        });
      } else if (left > 0.01 && t.status === 'done') {
        tsh.getRange(t.row, 8).setValue('open');
      }
    }
  }
  writePlan_(all);
  return { ok: true, date: ds, n: r.n, name: r.name, done: r.done, removed: removed };
}

/**
 * Mark a whole task finished (e.g. you finished early): hours_left 0, status done,
 * today's earlier/in-progress blocks for it count as done, and all its later blocks are removed.
 */
function completeTask_(taskId) {
  const t = readTasks_().filter(function (x) { return x.id === String(taskId); })[0];
  if (!t) throw new Error('no task ' + taskId);
  const tsh = sheet_('tasks', TASK_HEADERS);
  tsh.getRange(t.row, 7).setValue(0);
  tsh.getRange(t.row, 8).setValue('done');

  const today = todayStr_();
  const now = nowMin_();
  const cal = cal_(settings_());
  let removed = 0, credited = 0;
  const all = readPlan_().filter(function (r) {
    if (r.kind !== 'task' || r.taskId !== t.id || r.done) return true;
    const later = r.date > today || (r.date === today && r.start > now);
    if (later) { deleteEvent_(cal, r.eventId); removed++; return false; }
    if (r.date === today) { r.done = true; credited++; }
    return true;
  });
  writePlan_(all);
  return { ok: true, id: t.id, name: t.name, removed: removed, credited: credited };
}

/**
 * Tiny payload for the watch face (watch memory is very limited):
 * { d: date, bs: start BP, c0: first curve minute, c: BP every 30 min from wake to bed,
 *   pm: phone min, pb: phone budget, b: [[startMin, endMin, name, kind], ...] next blocks (max 6) }
 */
function faceJson_() {
  const ds = todayStr_();
  const s = settings_();
  const st = bpStatus_(ds, s);
  const now = nowMin_();
  let ph = { minutes: 0, budget: CONFIG.BUDGET_MIN };
  try { ph = daySummary_(ds); } catch (e) { /* no phone data */ }
  const b = readPlan_()
    .filter(function (r) { return r.date === ds && r.kind !== 'water' && r.end > now; })
    .sort(function (x, y) { return x.start - y.start; })
    .slice(0, 6)
    .map(function (r) { return [r.start, r.end, r.name.slice(0, 18), r.kind === 'task' ? 't' : r.kind === 'marker' ? 'm' : 'f']; });
  // bp = value right now, so the older watch face build (which only reads "bp") keeps working.
  return { d: ds, bp: st.now, bs: st.start, c0: st.curve.c0, c: st.curve.c, pm: ph.minutes, pb: ph.budget, b: b };
}

/** Compact day plan (JSON). */
function planJson_(ds) {
  ds = ds || todayStr_();
  const c = findCheckin_(ds);
  const blocks = readPlan_().filter(function (r) { return r.date === ds; }).map(function (r) {
    return { n: r.n, s: fmtHM(r.start), e: fmtHM(r.end), k: r.kind, t: r.name, bp: r.bp, d: r.done ? 1 : 0 };
  });
  return { ok: true, date: ds, bp: c ? c.bp : null, blocks: blocks };
}

// ---------- Triggers ----------
/** Runs ~00:05: save yesterday's phone total (for stats), then set up today. */
function nightly() {
  try { nightlyRollup(); } catch (e) { console.error(e); }
  withLock_(function () { ensureDay_(todayStr_()); });
}

/** Old hourly check-in trigger: no longer used. If it still fires, it removes itself. */
function autoCheckin() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoCheckin') ScriptApp.deleteTrigger(t);
  });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------- Sheet menu (desktop) ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Brain Points')
    .addItem('Replan rest of today', 'menuReplan')
    .addItem("Rebuild today's fixed blocks", 'menuRebuild')
    .addToUi();
}
function menuReplan() { SpreadsheetApp.getUi().alert(planText_(withLock_(replan_))); }
function menuRebuild() { withLock_(function () { buildFixedDay_(todayStr_()); }); SpreadsheetApp.getUi().alert('Rebuilt.'); }
