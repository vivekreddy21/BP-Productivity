/**
 * Brain Points — scheduler & scoring (pure logic, no Google services).
 * Times are "minutes since midnight" (0–1439). Days are integer day numbers.
 */

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "7:30", "07:30", "7:30 PM", "19:30:00" -> minutes since midnight (or null). */
function parseHM(s) {
  const m = String(s == null ? '' : s).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  const ap = m[3] ? m[3].toLowerCase().charAt(0) : null;
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

function fmtHM(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

/** "Daily", "Weekdays", "Weekends", "Mon,Wed,Fri", "tue thu" -> does it include weekday dow (0=Sun)? */
function daysMatch(spec, dow) {
  const s = String(spec == null ? '' : spec).trim().toLowerCase();
  if (!s || s === 'daily' || s === 'everyday' || s === 'every day') return true;
  if (s === 'weekdays') return dow >= 1 && dow <= 5;
  if (s === 'weekends') return dow === 0 || dow === 6;
  return s.split(/[\s,\/;]+/).some(function (tok) { return tok && DAY_NAMES.indexOf(tok.slice(0, 3)) === dow; });
}

/** Gaps in [start, end) not covered by busy intervals. */
function freeIntervals(start, end, busy) {
  const b = busy
    .map(function (x) { return { start: Math.max(start, x.start), end: Math.min(end, x.end) }; })
    .filter(function (x) { return x.end > x.start; })
    .sort(function (x, y) { return x.start - y.start; });
  const free = [];
  let cur = start;
  b.forEach(function (x) {
    if (x.start > cur) free.push({ start: cur, end: x.start });
    cur = Math.max(cur, x.end);
  });
  if (end > cur) free.push({ start: cur, end: end });
  return free;
}

/** priority = impact × urgency, urgency = 1/(daysLeft+1); overdue = 2; no deadline = treated as 2 weeks out. */
function taskPriority(t, today) {
  const daysLeft = t.deadlineDay == null ? 14 : t.deadlineDay - today;
  const urgency = daysLeft < 0 ? 2 : 1 / (daysLeft + 1);
  return (t.impact || 1) * urgency;
}

function blockCost(minutes, difficulty, s) {
  return Math.round((minutes / 60) * (difficulty || 1) * s.bp_per_hour_per_difficulty);
}

/**
 * Greedy planner: walk free time from earliest to latest; each slot gets the highest-priority task
 * that still has work left, hasn't hit its daily cap, and fits the remaining brain-point budget.
 *
 * opts: { free:[{start,end}], tasks:[{id,name,deadlineDay,impact,difficulty,minutesLeft}],
 *         today, budgetBP, settings }
 */
function planTasks(opts) {
  const s = opts.settings;
  const tasks = opts.tasks
    .filter(function (t) { return t.minutesLeft > 0; })
    .map(function (t) {
      // Due today or overdue = mandatory: scheduled even past the BP budget and the per-task daily cap.
      const mustDo = t.deadlineDay != null && t.deadlineDay <= opts.today;
      return Object.assign({}, t, { priority: taskPriority(t, opts.today), left: t.minutesLeft, usedToday: 0, mustDo: mustDo });
    })
    .sort(function (a, b) {
      return (b.mustDo - a.mustDo) || (b.priority - a.priority) ||
        ((a.deadlineDay == null ? 1e9 : a.deadlineDay) - (b.deadlineDay == null ? 1e9 : b.deadlineDay));
    });

  let budget = opts.budgetBP;
  const blocks = [];
  const MIN_ANY = 10; // never create blocks shorter than 10 minutes

  opts.free.forEach(function (iv) {
    let cur = iv.start;
    while (iv.end - cur >= MIN_ANY) {
      const room = iv.end - cur;
      let placed = false;
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        if (t.left <= 0) continue;
        let len = Math.min(t.left, s.max_block_min, room);
        if (!t.mustDo) {
          len = Math.min(len, s.max_task_min_per_day - t.usedToday);
          const perMinBP = (t.difficulty || 1) * s.bp_per_hour_per_difficulty / 60;
          if (perMinBP > 0) len = Math.min(len, Math.floor(Math.max(0, budget) / perMinBP));
        }
        const finishes = len >= t.left;
        if (!finishes) len = Math.floor(len / 5) * 5; // keep partial blocks on 5-minute steps
        if (len < MIN_ANY || (len < s.min_block_min && !finishes)) continue;
        const cost = blockCost(len, t.difficulty, s);
        blocks.push({ taskId: t.id, name: t.name, start: cur, end: cur + len, bp: cost });
        t.left -= len; t.usedToday += len; budget -= cost;
        cur += len + s.break_min;
        placed = true;
        break;
      }
      if (!placed) break;
    }
  });

  const unscheduled = tasks.filter(function (t) { return t.left > MIN_ANY; }); // ignore tiny leftovers
  return {
    blocks: blocks,
    bpLeft: budget,
    unscheduled: unscheduled.map(function (t) { return { id: t.id, name: t.name, minutesLeft: t.left }; }),
    atRisk: unscheduled
      .filter(function (t) { return t.deadlineDay != null && t.deadlineDay - opts.today <= 1; })
      .map(function (t) { return t.name; }),
  };
}

/**
 * Morning start: 100 minus a carry-over for yesterday's unfinished task blocks and overdue tasks.
 * blocks: yesterday's rows [{kind, bp, done}]
 */
function dayCarry(blocks, overdueCount, s) {
  let planned = 0, done = 0, unfinished = 0;
  blocks.forEach(function (b) {
    if (b.kind !== 'task') return;
    planned += b.bp;
    if (b.done) done += b.bp; else unfinished += b.bp;
  });
  const carry = Math.round(unfinished * s.stress_factor) + overdueCount * s.overdue_bp;
  return {
    plannedBP: planned, doneBP: done, carryBP: carry,
    scorePct: planned > 0 ? Math.round(done / planned * 100) : null,
    startBP: Math.max(s.bp_floor, Math.min(s.base_bp, s.base_bp - carry)),
  };
}

function clamp01_(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Brain points at minute `min`: start − steady baseline drain − each block's cost as it elapses. */
function bpAt(min, startBP, blocks, s) {
  let used = (s.baseline_bp || 0) * clamp01_((min - s.wake) / Math.max(1, s.bed - s.wake));
  blocks.forEach(function (b) {
    if (b.bp > 0 && b.end > b.start) used += b.bp * clamp01_((min - b.start) / (b.end - b.start));
  });
  return Math.round(startBP - used);
}

/** BP sampled every `step` minutes from wake to bed (the watch face interpolates between points). */
function bpCurve(startBP, blocks, s, step) {
  const c = [];
  for (let m = s.wake; m < s.bed + step; m += step) c.push(bpAt(m, startBP, blocks, s));
  return { c0: s.wake, step: step, c: c };
}

if (typeof module !== 'undefined') {
  module.exports = { parseHM: parseHM, fmtHM: fmtHM, daysMatch: daysMatch, freeIntervals: freeIntervals,
    taskPriority: taskPriority, blockCost: blockCost, planTasks: planTasks,
    dayCarry: dayCarry, bpAt: bpAt, bpCurve: bpCurve };
}
