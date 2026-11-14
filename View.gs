/**
 * Brain Points — phone dashboard (?key=SECRET&action=view).
 * One page: brain points, phone budget, today's timeline (tap to finish), and open tasks.
 */

function dashboardPage_(key) {
  const html = dashboardHtml_(dashboardData_(key));
  return HtmlService.createHtmlOutput(html)
    .setTitle('Brain Points')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function dashboardData_(key) {
  const ds = todayStr_();
  const today = dayNum_(ds);
  const st = bpStatus_(ds);
  const blocks = readPlan_().filter(function (r) { return r.date === ds && r.kind !== 'water'; })
    .sort(function (a, b) { return a.start - b.start; });
  let phone = { minutes: 0, budget: CONFIG.BUDGET_MIN, penaltyBP: 0 };
  try { phone = daySummary_(ds); } catch (e) { /* no data yet */ }
  const t = openTasksSorted_(today);
  const dt = new Date(today * 86400000);
  return {
    key: key,
    dateLabel: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dt.getUTCDay()] +
      ', ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getUTCMonth()] + ' ' + dt.getUTCDate(),
    bpNow: st.now, bpStart: st.start, bpEnd: st.end, carry: st.carry, base: settings_().base_bp,
    scorePct: st.yesterdayPct == null ? '' : st.yesterdayPct,
    phone: { minutes: phone.minutes, budget: phone.budget },
    nowMin: nowMin_(),
    blocks: blocks.map(function (r) { return { n: r.n, start: r.start, end: r.end, kind: r.kind, name: r.name, bp: r.bp, done: r.done }; }),
    tasks: t.open.map(function (x) {
      const diff = x.deadlineDay == null ? null : x.deadlineDay - today;
      return { id: x.id, name: x.name, due: dueLabel_(x.deadlineDay, today),
        urgency: diff == null ? 'none' : diff < 0 ? 'over' : diff === 0 ? 'today' : diff <= 2 ? 'soon' : 'later',
        hoursLeft: Math.round(x.hoursLeft * 10) / 10, impact: x.impact, difficulty: x.difficulty };
    }),
    closedCount: t.closedCount,
    selfUrl: ScriptApp.getService().getUrl() + '?key=' + encodeURIComponent(key) + '&action=view',
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
  };
}

// Called from the page via google.script.run (public names: no trailing underscore).
function apiToggle(key, n, value) {
  checkKey_(key);
  return withLock_(function () { return markDone_(n, todayStr_(), value); });
}
function apiComplete(key, taskId) {
  checkKey_(key);
  return withLock_(function () { return completeTask_(taskId); });
}
function apiReplan(key) {
  checkKey_(key);
  return planText_(withLock_(replan_));
}
function checkKey_(key) {
  const secret = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!secret || key !== secret) throw new Error('bad key');
}

// ---------- Rendering (pure: data in, HTML out) ----------
function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function to12_(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return ((h + 11) % 12 + 1) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? 'a' : 'p');
}

function dashboardHtml_(d) {
  const CHECKABLE = ['task', 'hobby', 'workout'];
  const ringPct = Math.max(0, Math.min(1, d.bpNow / Math.max(1, d.base)));
  const R = 52, C = 2 * Math.PI * R;
  const phonePct = Math.min(1, d.phone.minutes / Math.max(1, d.phone.budget));
  const phoneOver = d.phone.minutes > d.phone.budget;

  // Which block is "now" and which is next (markers like wind-down count too).
  let nowIdx = -1, nextIdx = -1;
  d.blocks.forEach(function (b, i) {
    if (nowIdx < 0 && b.start <= d.nowMin && d.nowMin < b.end && b.kind !== 'marker') nowIdx = i;
  });
  d.blocks.forEach(function (b, i) { if (nextIdx < 0 && b.start > d.nowMin) nextIdx = i; });

  const blockHtml = d.blocks.map(function (b, i) {
    const past = b.end <= d.nowMin;
    const cls = ['blk', 'k-' + esc_(b.kind), past ? 'past' : '', i === nowIdx ? 'now' : '', i === nextIdx ? 'next' : '', b.done ? 'done' : ''].join(' ');
    const tag = i === nowIdx ? '<span class="pill now-pill">NOW</span>' : i === nextIdx ? '<span class="pill">NEXT</span>' : '';
    const meta = b.bp ? b.bp + ' BP' : '';
    const check = CHECKABLE.indexOf(b.kind) >= 0
      ? '<button class="chk" aria-label="Mark done" onclick="toggle(' + b.n + ', this)">' + (b.done ? '&#10003;' : '') + '</button>'
      : '<span class="chk-spacer"></span>';
    return '<li class="' + cls + '">' +
      '<div class="time">' + to12_(b.start) + '<small>' + to12_(b.end) + '</small></div>' +
      '<div class="bar"></div>' +
      '<div class="body"><div class="name">' + esc_(b.name) + tag + '</div>' +
      (meta ? '<div class="meta">' + esc_(meta) + '</div>' : '') + '</div>' + check + '</li>';
  }).join('');

  const taskHtml = d.tasks.length ? d.tasks.map(function (t) {
    return '<li class="task u-' + t.urgency + '"><div class="t-main"><div class="name">' + esc_(t.name) + '</div>' +
      '<div class="meta">' + t.hoursLeft + 'h left &middot; impact ' + t.impact + ' &middot; diff ' + t.difficulty + '</div></div>' +
      '<span class="due">' + esc_(t.due) + '</span>' +
      '<button class="fin" onclick="complete(' + esc_(JSON.stringify(t.id)) + ', this)" aria-label="Complete task">&#10003;</button></li>';
  }).join('') : '<li class="empty">No open tasks. Nice.</li>';

  const ringCls = d.bpNow < 25 ? ' over' : d.bpNow < 50 ? ' mid' : '';
  const bpCard = '<svg class="ring" viewBox="0 0 120 120"><circle cx="60" cy="60" r="' + R + '" class="ring-bg"/>' +
      '<circle cx="60" cy="60" r="' + R + '" class="ring-fg' + ringCls + '" stroke-dasharray="' +
      (C * ringPct).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 60 60)"/>' +
      '<text x="60" y="58" class="ring-num">' + d.bpNow + '</text><text x="60" y="78" class="ring-lbl">brain points now</text></svg>' +
      '<div class="stats"><div><b>' + d.bpStart + '</b><span>this morning' +
        (d.carry ? ' (&minus;' + d.carry + ' unfinished)' : '') + '</span></div>' +
      '<div><b class="' + (d.bpEnd < 0 ? 'bad' : '') + '">' + d.bpEnd + '</b><span>at bedtime</span></div></div>';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + DASH_CSS_ + '</style></head><body>' +
    '<header><h1>' + esc_(d.dateLabel) + '</h1><a class="refresh" href="' + esc_(d.selfUrl) + '" target="_top">Refresh</a></header>' +
    '<section class="card hero">' + bpCard + '</section>' +
    '<section class="card phone"><div class="row"><span>Phone entertainment</span><b class="' + (phoneOver ? 'bad' : '') + '">' +
      d.phone.minutes + ' / ' + d.phone.budget + ' min</b></div>' +
      '<div class="track"><div class="fill' + (phoneOver ? ' over' : '') + '" style="width:' + (phonePct * 100).toFixed(0) + '%"></div></div>' +
      '<div class="note' + (phoneOver ? ' bad' : '') + '">' + (phoneOver ? (d.phone.minutes - d.phone.budget) + ' min over budget'
        : (d.phone.budget - d.phone.minutes) + ' min left today') + '</div>' +
    '</section>' +
    '<h2>Today</h2><ul class="card list">' + (blockHtml || '<li class="empty">Nothing planned yet.</li>') + '</ul>' +
    '<h2>Tasks <span class="count">' + d.tasks.length + '</span></h2><ul class="card list">' + taskHtml + '</ul>' +
    '<div class="actions"><button class="btn" onclick="replan(this)">Replan rest of today</button>' +
    '<a class="btn ghost" href="' + esc_(d.sheetUrl) + '" target="_top">Edit in Sheet</a></div>' +
    '<div id="toast"></div>' +
    '<script>var KEY=' + JSON.stringify(d.key) + ',SELF=' + JSON.stringify(d.selfUrl) + ';' + DASH_JS_ + '</script>' +
    '</body></html>';
}

const DASH_JS_ = [
  'function toast(m){var t=document.getElementById("toast");t.textContent=m;t.className="show";setTimeout(function(){t.className=""},3500)}',
  'function toggle(n,el){var li=el.parentNode,v=!li.classList.contains("done");el.disabled=true;',
  ' google.script.run.withSuccessHandler(function(r){if(r.removed){window.open(SELF,"_top");return}li.classList.toggle("done",r.done);el.innerHTML=r.done?"&#10003;":"";el.disabled=false})',
  ' .withFailureHandler(function(e){el.disabled=false;toast(e.message)}).apiToggle(KEY,n,v)}',
  // Two taps: first arms the button ("Done?"), second within 4 s completes the task and reloads.
  'function complete(id,b){if(!b.classList.contains("arm")){b.classList.add("arm");b.textContent="Done?";',
  ' setTimeout(function(){if(!b.disabled){b.classList.remove("arm");b.innerHTML="&#10003;"}},4000);return}',
  ' b.disabled=true;b.textContent="…";google.script.run.withSuccessHandler(function(){window.open(SELF,"_top")})',
  ' .withFailureHandler(function(e){b.disabled=false;b.classList.remove("arm");b.innerHTML="&#10003;";toast(e.message)}).apiComplete(KEY,id)}',
  'function replan(b){b.disabled=true;b.textContent="Planning…";',
  ' google.script.run.withSuccessHandler(function(){window.open(SELF,"_top")})',
  ' .withFailureHandler(function(e){b.disabled=false;b.textContent="Replan rest of today";toast(e.message)}).apiReplan(KEY)}',
].join('\n');

const DASH_CSS_ = [
  ':root{--bg:#f2f2f7;--card:#fff;--ink:#1c1c1e;--sub:#6e6e73;--line:#e5e5ea;--accent:#5b5bd6;--good:#2f9e66;--warn:#d9822b;--bad:#d64545;',
  ' --task:#5b5bd6;--class:#2f80ed;--meeting:#159a9c;--meal:#d9a21b;--workout:#2f9e66;--hobby:#2f9e66;--marker:#a1a1aa;--other:#8e8e93}',
  '@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--ink:#f2f2f7;--sub:#98989f;--line:#2c2c2e;--accent:#8b8bf0;--task:#8b8bf0}}',
  '*{box-sizing:border-box}body{margin:0;padding:16px 16px 40px;background:var(--bg);color:var(--ink);',
  ' font:15px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;-webkit-font-smoothing:antialiased;max-width:560px;margin:0 auto}',
  'header{display:flex;align-items:baseline;justify-content:space-between;margin:4px 2px 14px}',
  'h1{font-size:26px;font-weight:700;margin:0;letter-spacing:-.02em}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--sub);margin:22px 4px 8px;font-weight:600}',
  '.count{background:var(--line);color:var(--sub);border-radius:10px;padding:1px 7px;font-size:12px;margin-left:4px}',
  'a{color:var(--accent);text-decoration:none}.refresh{font-size:15px}',
  '.card{background:var(--card);border-radius:16px;padding:16px;margin:0 0 12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}',
  '.hero{display:flex;align-items:center;gap:18px}.ring{width:120px;height:120px;flex:none}',
  '.ring-bg{fill:none;stroke:var(--line);stroke-width:10}.ring-fg{fill:none;stroke:var(--accent);stroke-width:10;stroke-linecap:round}.ring-fg.over{stroke:var(--bad)}.ring-fg.mid{stroke:var(--warn)}',
  '.ring-num{font-size:34px;font-weight:700;text-anchor:middle;fill:var(--ink)}.ring-lbl{font-size:10px;text-anchor:middle;fill:var(--sub);letter-spacing:.04em}',
  '.stats{display:grid;gap:14px}.stats b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.stats span{color:var(--sub);font-size:13px}',
  '.nocheck b{display:block;font-size:18px;margin-bottom:4px}.nocheck span{color:var(--sub)}',
  '.row{display:flex;justify-content:space-between;align-items:baseline}.row b{font-variant-numeric:tabular-nums}',
  '.track{height:8px;background:var(--line);border-radius:4px;margin:10px 0 8px;overflow:hidden}.fill{height:100%;background:var(--good);border-radius:4px}.fill.over{background:var(--bad)}',
  '.note{color:var(--sub);font-size:13px}.bad{color:var(--bad)}',
  '.list{list-style:none;padding:4px 0;margin:0}.list li{display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--line)}.list li:first-child{border-top:0}',
  '.time{width:52px;flex:none;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}.time small{display:block;font-size:12px;font-weight:400;color:var(--sub)}',
  '.bar{width:4px;align-self:stretch;border-radius:2px;background:var(--other);flex:none}',
  '.k-task .bar{background:var(--task)}.k-class .bar{background:var(--class)}.k-meeting .bar{background:var(--meeting)}.k-meal .bar{background:var(--meal)}',
  '.k-workout .bar{background:var(--workout)}.k-hobby .bar{background:var(--hobby)}.k-marker .bar{background:var(--marker)}',
  '.body{flex:1;min-width:0}.name{font-weight:600;overflow-wrap:anywhere}.meta{color:var(--sub);font-size:13px;margin-top:1px}',
  '.k-marker .name{font-weight:500;color:var(--sub)}',
  '.past{opacity:.45}.now{background:color-mix(in srgb,var(--accent) 10%,transparent)}.now .time{color:var(--accent)}',
  '.pill{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.05em;border:1px solid var(--line);color:var(--sub);border-radius:6px;padding:1px 5px;margin-left:8px;vertical-align:2px}',
  '.now-pill{background:var(--accent);color:#fff;border-color:var(--accent)}',
  '.chk{width:28px;height:28px;border-radius:50%;border:2px solid var(--line);background:transparent;color:#fff;font-size:15px;font-weight:700;flex:none;padding:0;cursor:pointer}',
  '.chk-spacer{width:28px;flex:none}.done .chk{background:var(--good);border-color:var(--good)}.done .name{text-decoration:line-through;color:var(--sub)}.done{opacity:.7}',
  '.task .t-main{flex:1;min-width:0}.due{font-size:12px;font-weight:600;border-radius:8px;padding:4px 8px;white-space:nowrap;background:var(--line);color:var(--sub)}',
  '.u-over .due,.u-today .due{background:var(--bad);color:#fff}.u-soon .due{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}',
  '.u-over,.u-today{box-shadow:inset 3px 0 0 var(--bad)}',
  '.fin{flex:none;min-width:34px;height:34px;border-radius:17px;border:2px solid var(--line);background:transparent;color:var(--sub);',
  ' font:700 14px/1 inherit;padding:0 8px;cursor:pointer}',
  '.fin.arm{background:var(--good);border-color:var(--good);color:#fff}',
  '.empty{color:var(--sub);justify-content:center}',
  '.actions{display:flex;gap:10px;margin-top:18px}.btn{flex:1;text-align:center;font:600 15px/1 inherit;padding:14px;border-radius:12px;border:0;background:var(--accent);color:#fff;cursor:pointer}',
  '.btn.ghost{background:var(--card);color:var(--accent)}.btn:disabled{opacity:.6}',
  '#toast{position:fixed;left:16px;right:16px;bottom:20px;background:#1c1c1e;color:#fff;padding:12px 14px;border-radius:12px;opacity:0;transform:translateY(10px);transition:.25s;pointer-events:none}',
  '#toast.show{opacity:1;transform:none}',
].join('\n');

if (typeof module !== 'undefined') module.exports = { dashboardHtml_: dashboardHtml_ };
