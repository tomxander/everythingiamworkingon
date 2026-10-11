import { Renderer } from './render.js';
import { personFrame } from './sprites.js';
import { esc, md, timeStr, clockStr, fmtNum, fmtMoney, el, ago } from './util.js';
import { TEMPLATES } from './templates.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ------------------------------------------------------------ state
const st = {
  init: null, agents: {}, order: [], tasks: new Map(), deliv: new Map(), comms: [], log: [], stats: null, settings: null,
  snap: null, live: {}, selected: null, tab: 'tasks', openTasks: new Set(), commsFilter: 'all', unreadOutput: 0, fxSeen: new Set(),
};
let ws, renderer, reconnectDelay = 500;

// ------------------------------------------------------------ network
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { reconnectDelay = 500; };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => { toast('Connection lost. Reconnecting…', 'warn'); setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(8000, reconnectDelay * 1.6); };
}
const send = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };

function handle(m) {
  switch (m.type) {
    case 'init': return onInit(m);
    case 'tick': st.snap = m.snapshot; for (const a of m.snapshot.agents) st.live[a.id] = a; onSnapshot(); break;
    case 'comms': st.comms.push(m.msg); if (st.comms.length > 500) st.comms.shift(); appendComms(m.msg); break;
    case 'log': st.log.push(m.entry); if (st.log.length > 500) st.log.shift(); if (st.tab === 'log') renderLog(); break;
    case 'task': st.tasks.set(m.task.id, m.task); renderTasksSoon(); updateBadges(); break;
    case 'deliverable': st.deliv.set(m.deliverable.id, m.deliverable); if (st.tab !== 'output') st.unreadOutput++; renderOutputSoon(); updateBadges(); break;
    case 'stats': st.stats = m.stats; st.settings = m.settings; updateTop(); if (st.tab === 'metrics') renderMetrics(); break;
    case 'settings': st.settings = m.settings; updateTop(); if (!$('#modal').hidden && $('#modal-card').dataset.kind === 'settings') openSettings(); break;
    case 'toast': toast(m.text, m.level); break;
    case 'deliverable_full': openDeliverable(m.deliverable); break;
    case 'skill_full': openSkill(m.skill); break;
    default: break;
  }
}

// ------------------------------------------------------------ init
function onInit(m) {
  st.init = m; st.agents = Object.fromEntries(m.agents.map((a) => [a.id, a])); st.order = m.agents.map((a) => a.id);
  st.tasks = new Map(m.tasks.map((t) => [t.id, t])); st.deliv = new Map(m.deliverables.map((d) => [d.id, d]));
  st.comms = m.comms; st.log = m.log; st.stats = m.stats; st.settings = m.settings; st.snap = m.snapshot;
  for (const a of m.snapshot.agents) st.live[a.id] = a;
  $('#tagline').textContent = `· ${m.company.tagline}`;
  if (!renderer) {
    renderer = new Renderer($('#world'), m);
    bindStage();
    requestAnimationFrame(loop);
  }
  // console selects
  const sel = $('#task-assignee'); sel.innerHTML = '<option value="">Vera plans it</option>' + m.agents.map((a) => `<option value="${a.id}">${esc(a.short)} · ${esc(a.role)}</option>`).join('');
  const tpl = $('#task-tpl'); tpl.innerHTML = '<option value="">Templates…</option>' + TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('');
  renderTasks(); renderComms(); renderTeam(); renderOutput(); renderMetrics(); renderLog(); updateTop(); updateBadges();
  setTimeout(() => $('#loading').classList.add('gone'), 300);
  setTimeout(() => ($('#stage-hint').style.opacity = 0), 9000);
}

// ------------------------------------------------------------ render loop
let lastTeam = 0;
function loop(ts) {
  if (st.snap) {
    renderer.draw(st.snap, ts);
    handleFx();
    if (ts - lastTeam > 700) { lastTeam = ts; updateClock(); if (st.tab === 'team') updateTeam(); if (!$('#modal').hidden && $('#modal-card').dataset.kind === 'agent') updateInspector(); }
  }
  requestAnimationFrame(loop);
}
function onSnapshot() { /* snapshot data is consumed by the render loop */ }

function handleFx() {
  const live = new Set();
  for (const f of st.snap.fx) {
    live.add(f.id);
    if (f.kind === 'godvoice' && !st.fxSeen.has(f.id)) {
      st.fxSeen.add(f.id);
      const g = $('#godvoice'); g.innerHTML = `<small>THE VOICE OF GOD</small>${esc(f.text)}`; g.hidden = false; g.style.animation = 'none'; void g.offsetWidth; g.style.animation = '';
      clearTimeout(g._t); g._t = setTimeout(() => (g.hidden = true), Math.max(2500, f.life * 1000 - 800));
    }
  }
  if (st.fxSeen.size > 200) st.fxSeen = new Set([...st.fxSeen].filter((id) => live.has(id)));
}

// ------------------------------------------------------------ stage interaction
function bindStage() {
  const cv = $('#world');
  const ro = new ResizeObserver(() => renderer.resize()); ro.observe(cv);
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, moved: false }; });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; cv.classList.add('dragging'); renderer.follow = null; }
      if (drag.moved) { renderer.pan(dx, dy); drag.x = e.clientX; drag.y = e.clientY; }
    } else if (st.snap) {
      const id = renderer.agentAt(sx, sy, st.snap); renderer.hover = id; cv.classList.toggle('pointer', !!id);
    }
  });
  cv.addEventListener('pointerup', (e) => {
    cv.classList.remove('dragging');
    if (drag && !drag.moved && st.snap) {
      const r = cv.getBoundingClientRect(); const id = renderer.agentAt(e.clientX - r.left, e.clientY - r.top, st.snap);
      if (id) selectAgent(id, { open: true }); else { renderer.selected = null; st.selected = null; }
    }
    drag = null;
  });
  cv.addEventListener('pointerleave', () => { renderer.hover = null; });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); renderer.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  cv.addEventListener('dblclick', (e) => { const r = cv.getBoundingClientRect(); const id = renderer.agentAt(e.clientX - r.left, e.clientY - r.top, st.snap); if (id) { renderer.follow = id; renderer.cam.zoom = Math.max(renderer.cam.zoom, 3); } });
  $('#btn-fit').onclick = () => { renderer.follow = null; renderer.fit(); };
  window.addEventListener('keydown', (e) => {
    if (/input|textarea|select/i.test(document.activeElement?.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); send({ type: 'pause', paused: !st.snap.paused }); }
    if (e.key === 'f' || e.key === 'F') { renderer.follow = null; renderer.fit(); }
    if (e.key === '+' || e.key === '=') renderer.zoomAt(renderer.vw / 2, renderer.vh / 2, 1.25);
    if (e.key === '-') renderer.zoomAt(renderer.vw / 2, renderer.vh / 2, 0.8);
    if (e.key === 'Escape') { closeModal(); renderer.follow = null; }
  });
}

function selectAgent(id, { open = false, focus = false } = {}) {
  st.selected = id; renderer.selected = id;
  if (focus && st.snap) { const a = st.live[id]; renderer.centerOn(a.x, a.y, Math.max(renderer.cam.zoom, 2.4)); }
  if (open) openInspector(id);
  if (st.tab === 'team') updateTeam();
}

// ------------------------------------------------------------ top bar
function updateClock() {
  const s = st.snap; if (!s) return;
  $('#clock').textContent = `Day ${s.day} · ${clockStr(s.clock)}`;
  const h = s.clock / 60; $('#clock-icon').textContent = h >= 6 && h < 19 ? '☀' : '☾';
  $$('#speed button').forEach((b) => { if (b.dataset.speed) b.classList.toggle('on', !s.paused && Number(b.dataset.speed) === s.speed); if (b.dataset.act === 'pause') b.classList.toggle('on', s.paused); });
}
function updateTop() {
  const s = st.settings, stt = st.stats; if (!s) return;
  const live = s.mode === 'live';
  $('#mode-chip').classList.toggle('live', live);
  $('#mode-label').textContent = live ? `LIVE · ${s.model}` : 'SIMULATED';
  const t = stt?.llm?.totals;
  if (t) { $('#tok').textContent = fmtNum(t.inputTokens + t.outputTokens); $('#cost').textContent = (t.simulated ? '~' : '') + fmtMoney(t.cost); }
  $('#cap').textContent = `$${s.budgetCap}`;
}
$('#speed').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.act === 'pause') send({ type: 'pause', paused: !st.snap?.paused });
  else { send({ type: 'pause', paused: false }); send({ type: 'speed', speed: Number(b.dataset.speed) }); }
});
$('#mode-chip').onclick = () => openSettings();
$('#btn-settings').onclick = () => openSettings();

function updateBadges() {
  const active = [...st.tasks.values()].filter((t) => ['queued', 'planning', 'active', 'review'].includes(t.status)).length;
  $('#n-tasks').textContent = active || '';
  $('#n-output').textContent = st.unreadOutput || '';
}

// ------------------------------------------------------------ tabs
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; setTab(b.dataset.tab);
});
function setTab(tab) {
  st.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.panel').forEach((p) => p.classList.toggle('on', p.id === `p-${tab}`));
  if (tab === 'output') { st.unreadOutput = 0; updateBadges(); }
  if (tab === 'team') renderTeam(); if (tab === 'metrics') renderMetrics(); if (tab === 'log') renderLog(); if (tab === 'comms') { renderComms(); }
}

// ------------------------------------------------------------ tasks panel
let tasksQueued = false;
function renderTasksSoon() { if (tasksQueued) return; tasksQueued = true; setTimeout(() => { tasksQueued = false; renderTasks(); }, 120); }

function avatar(id, extra = '') {
  const a = st.agents[id]; if (id === 'god') return `<span class="av" style="background:var(--gold)">☼</span>`;
  if (!a) return `<span class="av" style="background:#555">?</span>`;
  const working = st.live[id]?.busy ? 'working' : '';
  return `<span class="av ${working} ${extra}" style="background:${a.color}" title="${esc(a.name)}">${esc(a.short.slice(0, 2).toUpperCase())}</span>`;
}
const nm = (id) => (id === 'god' ? 'God' : id === 'all' ? 'everyone' : st.agents[id]?.short || id);

function renderTasks() {
  const p = $('#p-tasks');
  const tasks = [...st.tasks.values()].sort((a, b) => b.created - a.created);
  if (!tasks.length) {
    p.innerHTML = `<div class="empty"><div class="big">🏢</div><b>The office is waiting for your command, God.</b><p>Type a task in the God Console below, or pick a template. Vera, the CMO, will plan it and assign specialists.</p><button class="btn primary" id="try-demo">Try a demo task</button></div>`;
    $('#try-demo').onclick = () => { applyTemplate(0); $('#task-form').requestSubmit(); };
    return;
  }
  p.innerHTML = tasks.map((t) => {
    const done = t.subtasks.filter((s) => s.status === 'done').length, total = t.subtasks.length;
    const pct = t.status === 'done' ? 100 : total ? Math.round((done / total) * (t.status === 'review' ? 95 : 90)) : t.status === 'planning' ? 6 : 0;
    const agents = [...new Set(t.subtasks.map((s) => s.agent))];
    const open = st.openTasks.has(t.id);
    return `<div class="card ${open ? 'open' : ''}" data-id="${t.id}">
      <div class="task-head" data-toggle="${t.id}"><span class="task-id">${t.id}</span><span class="task-title">${esc(t.title)}</span><span class="status ${t.status}">${t.status}</span></div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="task-meta"><span class="avatars">${agents.length ? agents.map((a) => avatar(a)).join('') : '<span>Vera is planning…</span>'}</span><span>${total ? `${done}/${total}` : ''} ${t.tokens ? `· ${fmtNum(t.tokens)} tok` : ''}${t.simulated ? ' · sim' : ''}</span></div>
      ${open ? taskDetail(t) : ''}
    </div>`;
  }).join('');
  $$('[data-toggle]', p).forEach((h) => (h.onclick = () => { const id = h.dataset.toggle; st.openTasks.has(id) ? st.openTasks.delete(id) : st.openTasks.add(id); renderTasks(); }));
  $$('[data-skill]', p).forEach((s) => (s.onclick = (e) => { e.stopPropagation(); send({ type: 'skill', name: s.dataset.skill }); }));
  $$('[data-deliv]', p).forEach((s) => (s.onclick = () => send({ type: 'deliverable', id: s.dataset.deliv })));
  $$('[data-retry]', p).forEach((s) => (s.onclick = () => send({ type: 'retry', taskId: s.dataset.retry })));
  $$('[data-agent]', p).forEach((s) => (s.onclick = () => selectAgent(s.dataset.agent, { focus: true })));
}

function taskDetail(t) {
  const subs = t.subtasks.map((s) => `<div class="sub">${avatar(s.agent)}<div class="what"><b data-agent="${s.agent}" style="cursor:pointer">${esc(st.agents[s.agent]?.short || s.agent)}</b> <span class="skill" data-skill="${s.skill}">${s.skill}</span>${s.consult ? ` <span class="muted">· consulted ${esc(nm(s.consult))}</span>` : ''}
        <div class="hl">${esc(s.status === 'done' ? (s.headline || s.instruction) : s.instruction)}</div>${s.review ? `<div class="rv">${esc(nm(s.review.by))}: ${esc(s.review.text)}</div>` : ''}</div>
        <div style="text-align:right"><span class="status ${s.status === 'working' ? 'active' : s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : ''}">${s.status}</span>${s.outputId ? `<div><button class="btn sm" data-deliv="${s.outputId}" style="margin-top:4px">Read</button></div>` : ''}</div></div>`).join('');
  return `${t.brief ? `<div class="plan"><b>Brief:</b> ${esc(t.brief)}</div>` : ''}${intakeHtml(t)}${t.plan ? `<div class="plan"><b>Plan:</b> ${esc(t.plan.summary)}</div>` : ''}${subs}
    <div class="row" style="margin-top:10px">${t.summaryId ? `<button class="btn primary" data-deliv="${t.summaryId}">Read executive summary</button>` : ''}${t.profileId ? `<button class="btn" data-deliv="${t.profileId}">Client profile</button>` : ''}${['failed', 'interrupted'].includes(t.status) ? `<button class="btn" data-retry="${t.id}">Retry</button>` : ''}${t.error ? `<span class="muted">${esc(t.error)}</span>` : ''}</div>`;
}

function intakeHtml(t) {
  const i = t.intake; const src = t.sources || [];
  if (!i && !src.length) return '';
  const srcHtml = src.map((x) => x.pages.length
    ? `<div class="srcline">Read <b>${x.pages.length}</b> page${x.pages.length > 1 ? 's' : ''} of <b>${esc(x.host)}</b>${x.cached ? ' (cached)' : ''}: ${x.pages.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(p.url).pathname || '/')}</a>`).join(', ')}</div>${x.findings?.length ? `<ul class="finds">${x.findings.slice(0, 5).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}`
    : `<div class="srcline bad">Could not read <b>${esc(x.host)}</b>: ${esc(x.errors?.[0]?.error || 'unknown error')}. Everything about it is marked Not verified.</div>`).join('');
  if (!i) return `<div class="intake">${srcHtml}</div>`;
  return `<div class="intake"><div class="ih">Intake brief</div>
    <div class="kv"><span>Objective</span><b>${esc(i.objective)}</b><span>Metric</span><b>${esc(i.metric)}</b><span>Target</span><b>${esc(i.target)}</b><span>Timeframe</span><b>${esc(i.timeframe)}</b><span>Budget</span><b>${esc(i.budget)}</b></div>
    ${srcHtml}
    ${i.assumptions?.length ? `<div class="ih">Assumptions</div><ul class="finds">${i.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
    ${i.openQuestions?.length ? `<div class="ih q">Open questions for you</div><ul class="finds">${i.openQuestions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul><div class="muted" style="font-size:11px">Answer these in a new task brief to sharpen the next run.</div>` : ''}</div>`;
}

// ------------------------------------------------------------ comms panel
function renderComms() {
  const p = $('#p-comms');
  const f = st.commsFilter;
  const btn = (k, l) => `<button data-f="${k}" class="${f === k ? 'on' : ''}">${l}</button>`;
  p.innerHTML = `<div class="filters">${btn('all', 'All')}${btn('work', 'Work')}${btn('talk', 'Consults & reviews')}${btn('banter', 'Banter')}${btn('god', 'God')}</div><div id="feed"></div>`;
  $$('.filters button', p).forEach((b) => (b.onclick = () => { st.commsFilter = b.dataset.f; renderComms(); }));
  const feed = $('#feed', p);
  const msgs = st.comms.filter(passes).slice(-160);
  feed.innerHTML = msgs.length ? msgs.map(msgHtml).join('') : `<div class="empty">Nothing here yet.</div>`;
  p.scrollTop = p.scrollHeight;
}
function passes(m) {
  const f = st.commsFilter;
  if (f === 'all') return true; if (f === 'work') return m.kind === 'task'; if (f === 'talk') return m.kind === 'consult' || m.kind === 'review';
  if (f === 'banter') return m.kind === 'banter'; if (f === 'god') return m.from === 'god' || m.to === 'god';
  return true;
}
function msgHtml(m) {
  return `<div class="msg ${m.kind} ${m.from === 'god' ? 'god' : ''}">${avatar(m.from)}<div><div class="who">${esc(nm(m.from))} <span class="to">→ ${esc(nm(m.to))}</span><span class="kind ${m.kind}">${m.kind}</span><span class="when">${timeStr(m.wall)}</span></div><div class="txt">${esc(m.text)}</div></div></div>`;
}
function appendComms(m) {
  if (st.tab !== 'comms' || !passes(m)) return;
  const p = $('#p-comms'), feed = $('#feed', p); if (!feed) return;
  const atBottom = p.scrollHeight - p.scrollTop - p.clientHeight < 80;
  feed.insertAdjacentHTML('beforeend', msgHtml(m));
  while (feed.children.length > 200) feed.firstChild.remove();
  if (atBottom) p.scrollTop = p.scrollHeight;
}

// ------------------------------------------------------------ team panel
function renderTeam() {
  const p = $('#p-team'); const byDept = {};
  for (const id of st.order) (byDept[st.agents[id].dept] ||= []).push(id);
  p.innerHTML = Object.entries(byDept).map(([d, ids]) => `<div class="dept-title" style="color:${st.init.depts[d].color}"><i style="background:${st.init.depts[d].color}"></i>${esc(st.init.depts[d].label)}</div>` + ids.map((id) => {
    const a = st.agents[id];
    return `<div class="person" data-id="${id}"><canvas width="48" height="72" data-av="${id}"></canvas><div><div class="nm">${esc(a.name)}</div><div class="rl">${esc(a.role)}</div><div class="st" data-st="${id}"></div>
      <div class="bars"><span>EN</span><div class="bar en"><i data-en="${id}"></i></div><span>MO</span><div class="bar mo"><i data-mo="${id}"></i></div></div></div></div>`;
  }).join('')).join('');
  $$('canvas[data-av]', p).forEach((c) => { const a = st.agents[c.dataset.av]; const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(personFrame(a.id, a.look, 'down', 'stand', 0), 0, 0, 48, 72); });
  $$('.person', p).forEach((c) => (c.onclick = () => { selectAgent(c.dataset.id, { focus: true, open: true }); }));
  updateTeam();
}
function updateTeam() {
  const p = $('#p-team');
  for (const id of st.order) {
    const l = st.live[id]; if (!l) continue;
    const s = $(`[data-st="${id}"]`, p); if (s) s.textContent = (l.busy ? '● ' : '') + l.status;
    const en = $(`[data-en="${id}"]`, p), mo = $(`[data-mo="${id}"]`, p);
    if (en) en.style.width = `${l.energy}%`; if (mo) mo.style.width = `${l.mood}%`;
  }
  $$('.person', p).forEach((c) => c.classList.toggle('sel', c.dataset.id === st.selected));
}

// ------------------------------------------------------------ output panel
let outQueued = false;
function renderOutputSoon() { if (outQueued) return; outQueued = true; setTimeout(() => { outQueued = false; renderOutput(); }, 150); }
function renderOutput() {
  const p = $('#p-output');
  const list = [...st.deliv.values()].sort((a, b) => b.created - a.created);
  if (!list.length) { p.innerHTML = `<div class="empty"><div class="big">📄</div>Deliverables from the team will appear here, each saved as Markdown in <code>deliverables/</code>.</div>`; return; }
  p.innerHTML = list.map((d) => `<div class="card deliv" data-id="${d.id}"><div class="tagrow">${avatar(d.agent)}<span class="pill ${d.kind === 'summary' || d.kind === 'profile' ? 'sum' : ''}">${d.kind === 'summary' ? 'executive summary' : d.kind === 'profile' ? 'client profile' : esc(d.skill)}</span><span class="pill">${d.taskId}</span>${d.simulated ? '<span class="pill sim">simulated</span>' : ''}<span>${d.words} words</span></div><div class="t">${esc(d.title)}</div><div class="pv">${esc(d.preview)}</div></div>`).join('');
  $$('.deliv', p).forEach((c) => (c.onclick = () => send({ type: 'deliverable', id: c.dataset.id })));
}

// ------------------------------------------------------------ metrics panel
function renderMetrics() {
  const p = $('#p-metrics'); const s = st.stats; if (!s) return;
  const t = s.llm.totals; const live = s.llm.mode === 'live';
  const tile = (k, v, sub = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}${sub ? ` <small>${sub}</small>` : ''}</div></div>`;
  const hist = s.history || [];
  const depts = Object.values(s.depts);
  const maxTasks = Math.max(1, ...depts.map((d) => d.deliverables));
  const skillMax = Math.max(1, ...Object.values(s.skillUse || {}));
  p.innerHTML = `
    <div class="tiles">
      ${tile('Tasks done', s.completed, `of ${s.tasks}`)}${tile('Deliverables', s.deliverables)}${tile('Active', s.active, `+${s.queued} queued`)}
      ${tile('Tokens', fmtNum(t.inputTokens + t.outputTokens), t.simulated ? 'est.' : '')}${tile('Spend', (t.simulated ? '~' : '') + fmtMoney(t.cost), `/ $${s.budgetCap}`)}${tile('API calls', t.calls)}
      ${tile('Morale', s.morale + '%')}${tile('Energy', s.energy + '%')}${tile('Cached', fmtNum(t.cacheReadTokens), 'tok')}
    </div>
    ${live ? '' : `<div class="notice">Simulated mode: tokens and cost are estimates of what the real calls would use. Add an API key in Settings to run live Claude agents.</div>`}
    <h3 class="sect">Token usage over time</h3>${spark(hist.map((h) => h.tokens), '#5ee7ff')}
    <h3 class="sect">Deliverables over time</h3>${spark(hist.map((h) => h.delivs), '#ff6ec7')}
    <h3 class="sect">Departments</h3>
    ${depts.map((d) => `<div class="drow"><span style="color:${d.color}">● ${esc(d.label)}</span><div class="bar mo"><i style="width:${(d.deliverables / maxTasks) * 100}%;background:${d.color}"></i></div><span class="n">${d.deliverables} out · ${d.working}/${d.n} busy</span></div>`).join('')}
    <h3 class="sect">The Skill Vault <span class="muted">· ${st.init.skills.length} playbooks · brighter = used more</span></h3>
    <input class="search" id="skill-search" placeholder="Search skills…" />
    <div class="vault" id="vault"></div>`;
  const draw = (q = '') => {
    const v = $('#vault', p); const ql = q.toLowerCase();
    v.innerHTML = st.init.skills.filter((k) => !ql || k.name.includes(ql) || k.summary.toLowerCase().includes(ql)).map((k) => {
      const n = s.skillUse[k.name] || 0; const lvl = n ? Math.min(3, 1 + Math.floor((n / skillMax) * 2.99)) : 0;
      return `<div class="skill ${lvl ? 'hot' + lvl : ''}" data-skill="${k.name}" title="${esc(k.summary)}">${k.name}${n ? `<b>${n}</b>` : ''}</div>`;
    }).join('');
    $$('.skill', v).forEach((el_) => (el_.onclick = () => send({ type: 'skill', name: el_.dataset.skill })));
  };
  draw(); $('#skill-search', p).oninput = (e) => draw(e.target.value);
}
function spark(vals, color) {
  if (vals.length < 2) return `<svg class="spark" viewBox="0 0 300 70"><text x="150" y="38" fill="#5d6690" font-size="11" text-anchor="middle" font-family="monospace">collecting data…</text></svg>`;
  const max = Math.max(1, ...vals), min = Math.min(...vals); const span = Math.max(1, max - min);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 292 + 4},${62 - ((v - min) / span) * 52}`);
  return `<svg class="spark" viewBox="0 0 300 70" preserveAspectRatio="none"><polyline points="${pts.join(' ')} 296,66 4,66" fill="${color}22" stroke="none"/><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}

// ------------------------------------------------------------ log
function renderLog() {
  const p = $('#p-log');
  p.innerHTML = st.log.length ? [...st.log].reverse().slice(0, 200).map((e) => `<div class="log"><span class="tm">${timeStr(e.wall)}</span><span>${esc(e.text)}</span></div>`).join('') : `<div class="empty">The log is empty.</div>`;
}

// ------------------------------------------------------------ modals
const modal = $('#modal'), card = $('#modal-card');
function openModal(html, kind, wide = false) { card.innerHTML = html; card.dataset.kind = kind; card.classList.toggle('wide', wide); modal.hidden = false; $('.close', card)?.addEventListener('click', closeModal); }
function closeModal() { modal.hidden = true; card.innerHTML = ''; card.dataset.kind = ''; }
modal.addEventListener('pointerdown', (e) => { if (e.target === modal) closeModal(); });

function openDeliverable(d) {
  const a = st.agents[d.agent];
  openModal(`<button class="btn close">✕</button><div class="tagrow">${avatar(d.agent)}<b>${esc(a?.name || d.agent)}</b><span class="pill">${esc(d.skill)}</span><span class="pill">${d.taskId}</span>${d.simulated ? '<span class="pill sim">simulated</span>' : ''}</div>
    <div class="md">${md(d.markdown)}</div><div class="row" style="margin-top:16px"><a class="btn" href="/api/deliverable/${d.id}.md" download>Download .md</a><button class="btn" id="copy-md">Copy Markdown</button></div>`, 'deliv', true);
  $('#copy-md').onclick = (e) => { navigator.clipboard?.writeText(d.markdown).then(() => (e.target.textContent = 'Copied')); };
}
function openSkill(s) {
  openModal(`<button class="btn close">✕</button><h2>${esc(s.title)}</h2><div class="muted" style="margin-bottom:10px">skill: <code>${esc(s.name)}</code> · from coreyhaines31/marketingskills</div>
    <div class="notice">${esc(s.description)}</div><div class="md">${md(s.body)}</div>`, 'skill', true);
}

function openInspector(id) {
  const a = st.agents[id];
  openModal(`<button class="btn close">✕</button><div class="insp"><canvas id="insp-av" width="48" height="72"></canvas><div>
    <h2>${esc(a.name)}</h2><div class="muted">${esc(a.role)} · ${esc(st.init.depts[a.dept].label)}</div>
    <p>${esc(a.persona)}</p><div id="insp-live" class="notice"></div>
    <div class="row"><button class="btn" id="i-follow">Follow</button><button class="btn" id="i-bless">✨ Bless</button><button class="btn" id="i-smite">⚡ Smite (lightly)</button><button class="btn primary" id="i-task">Assign task</button></div></div></div>
    <h3 class="sect" style="margin-top:18px">Skills</h3><div class="chips">${a.skills.map((k) => `<span class="skill" data-skill="${k}">${k}</span>`).join('')}</div>
    <h3 class="sect">Talk to ${esc(a.short)}</h3><form class="row" id="i-chat"><input class="field" style="flex:1" id="i-chat-text" placeholder="Say something to ${esc(a.short)}…" maxlength="500"/><button class="btn">Send</button></form><div id="i-reply" class="muted" style="margin-top:6px"></div>
    <h3 class="sect">Memory</h3><div id="insp-mem"></div>`, 'agent');
  const c = $('#insp-av').getContext('2d'); c.imageSmoothingEnabled = false; c.drawImage(personFrame(a.id, a.look, 'down', 'stand', 0), 0, 0, 48, 72);
  $('#i-follow').onclick = () => { closeModal(); renderer.follow = id; renderer.cam.zoom = Math.max(renderer.cam.zoom, 3); };
  $('#i-bless').onclick = () => send({ type: 'bless', agent: id }); $('#i-smite').onclick = () => send({ type: 'smite', agent: id });
  $('#i-task').onclick = () => { closeModal(); $('#task-assignee').value = id; $('#task-title').focus(); };
  $$('.skill', card).forEach((s) => (s.onclick = () => send({ type: 'skill', name: s.dataset.skill })));
  $('#i-chat').onsubmit = (e) => { e.preventDefault(); const v = $('#i-chat-text').value.trim(); if (!v) return; send({ type: 'chat', agent: id, text: v }); $('#i-chat-text').value = ''; $('#i-reply').textContent = `${a.short} is thinking…`; };
  updateInspector();
}
function updateInspector() {
  const id = st.selected; const a = st.agents[id]; const l = st.live[id]; if (!a || !l) return;
  const live = $('#insp-live'); if (!live) return;
  const s = st.stats?.agents?.find((x) => x.id === id);
  live.innerHTML = `<b>${l.busy ? '● Working' : 'Free'}</b> · ${esc(l.status)}<br><span class="muted">Energy ${l.energy}% · Mood ${l.mood}%${s ? ` · ${s.stats.deliverables} deliverables · ${fmtNum(s.stats.tokens)} tokens · ${s.stats.consults} consults` : ''}</span>`;
  const mem = $('#insp-mem'); if (mem && s) mem.innerHTML = s.memory.length ? [...s.memory].reverse().map((m) => `<div class="mem">${esc(m.text)}</div>`).join('') : '<div class="muted">Nothing yet.</div>';
  const last = [...st.comms].reverse().find((m) => m.kind === 'dm' && m.from === id);
  const rep = $('#i-reply'); if (rep && last && !rep.textContent.endsWith('thinking…')) rep.innerHTML = `<b style="color:${a.color}">${esc(a.short)}:</b> ${esc(last.text)}`;
  else if (rep && last && rep.textContent.endsWith('thinking…') && last.wall > (rep._t || 0)) { rep.innerHTML = `<b style="color:${a.color}">${esc(a.short)}:</b> ${esc(last.text)}`; }
}

function openSettings() {
  const s = st.settings; if (!s) return;
  openModal(`<button class="btn close">✕</button><h2>Settings</h2><div class="muted">How the agents think.</div>
    <div class="notice ${s.mode === 'live' ? '' : 'warn'}">${s.mode === 'live' ? `<b>Live.</b> Real Claude (${esc(s.model)}) is running the agents. Spend is capped at $${s.budgetCap}; when the cap is hit the office drops back to simulation.` : `<b>Simulated.</b> The office runs on a built-in simulator so you can see everything work without an API key. Deliverables are stamped SIMULATED. Add a key to make the agents really think.`}</div>
    <label class="field-label">Anthropic API key ${s.hasKey ? '<span style="color:var(--green)">· set (held in server memory only)</span>' : ''}</label>
    <div class="row"><input class="field" style="flex:1" id="s-key" type="password" placeholder="${s.hasKey ? '•••••••• (leave blank to keep)' : 'sk-ant-…'}" autocomplete="off" /><button class="btn primary" id="s-save">${s.hasKey ? 'Update & go live' : 'Save & go live'}</button></div>
    <label class="field-label">Model</label><div class="row"><input class="field" style="flex:1" id="s-model" value="${esc(s.model)}" /><button class="btn" id="s-model-save">Set</button></div>
    <label class="field-label">Budget cap (USD, estimated)</label><div class="row"><input class="field" style="flex:1" id="s-budget" type="number" min="0.1" step="0.5" value="${s.budgetCap}" /><button class="btn" id="s-budget-save">Set</button></div>
    <label class="field-label">Mode</label><div class="row"><button class="btn ${s.mode === 'mock' ? 'primary' : ''}" id="s-mock">Simulated</button><button class="btn ${s.mode === 'live' ? 'primary' : ''}" id="s-live" ${s.hasKey ? '' : 'disabled'}>Live</button></div>
    ${s.lastError ? `<div class="notice warn">Last API error: ${esc(s.lastError)}</div>` : ''}
    <div class="notice" style="margin-top:16px">Prices used for cost estimates: $${s.price.in}/M input, $${s.price.out}/M output tokens (override with the <code>PRICE_IN</code> / <code>PRICE_OUT</code> env vars). Your key is never written to disk; you can also set <code>ANTHROPIC_API_KEY</code> before starting the server.</div>`, 'settings');
  $('#s-save').onclick = () => { const key = $('#s-key').value.trim(); if (!key && !s.hasKey) return; send({ type: 'setKey', key: key || undefined, useLive: true }); if (!key) send({ type: 'setMode', mode: 'live' }); };
  $('#s-model-save').onclick = () => send({ type: 'setModel', model: $('#s-model').value });
  $('#s-budget-save').onclick = () => send({ type: 'setBudget', value: $('#s-budget').value });
  $('#s-mock').onclick = () => send({ type: 'setMode', mode: 'mock' }); $('#s-live').onclick = () => send({ type: 'setMode', mode: 'live' });
}

// ------------------------------------------------------------ God console
function applyTemplate(i) {
  const t = TEMPLATES[i]; if (!t) return;
  $('#task-title').value = t.title; $('#task-brief').value = t.brief; $('#task-assignee').value = t.assignee || '';
}
$('#task-tpl').onchange = (e) => { if (e.target.value !== '') applyTemplate(Number(e.target.value)); e.target.value = ''; };
$('#task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#task-title').value.trim(); if (!title) { $('#task-title').focus(); return; }
  send({ type: 'task', title, brief: $('#task-brief').value.trim(), assignee: $('#task-assignee').value || null });
  $('#task-title').value = ''; $('#task-brief').value = ''; $('#task-assignee').value = '';
  setTab('tasks');
});
$('#task-title').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#task-form').requestSubmit(); });
$('#p-coffee').onclick = () => send({ type: 'coffee' });
$('#p-town').onclick = () => send({ type: 'townhall' });
$('#p-announce').onclick = () => {
  openModal(`<button class="btn close">✕</button><h2>Speak, God</h2><div class="muted">Everyone free will gather and listen.</div>
    <form id="ann-form"><label class="field-label">Your message</label><input class="field" id="ann-text" maxlength="280" placeholder="Today we ship something the world has never seen." autofocus /><div class="row" style="margin-top:14px"><button class="btn primary">Announce</button></div></form>`, 'announce');
  $('#ann-form').onsubmit = (e) => { e.preventDefault(); const v = $('#ann-text').value.trim(); if (v) { send({ type: 'announce', text: v }); closeModal(); } };
  setTimeout(() => $('#ann-text')?.focus(), 30);
};

// ------------------------------------------------------------ toasts
function toast(text, level = 'info') {
  const t = el('div', { class: `toast ${level}` }, text); $('#toasts').appendChild(t); setTimeout(() => t.remove(), 5200);
}

connect();
