import { Renderer } from './render.js';
import { personFrame } from './sprites.js';
import { esc, md, timeStr, clockStr, fmtNum, fmtMoney, el, ago } from './util.js';
import { TEMPLATES } from './templates.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ------------------------------------------------------------ state
const st = {
  init: null, agents: {}, order: [], tasks: new Map(), deliv: new Map(), comms: [], log: [], stats: null, settings: null,
  snap: null, live: {}, selected: null, tab: 'tasks', openTasks: new Set(), commsFilter: 'all', commsTask: 'all', unreadOutput: 0, fxSeen: new Set(),
  kb: null, hiring: null, hr: null, requests: [], rqFiles: {}, brainFilter: 'all', brainQuery: '', pendingHires: [],
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
    case 'settings': st.settings = m.settings; updateTop(); refreshSettings(); break;
    case 'toast': toast(m.text, m.level); break;
    case 'skills_updated': if (m.skills) st.init.skills = m.skills; if (m.source && st.settings) st.settings.skills = m.source; if (st.tab === 'brain') renderBrain(); if (st.tab === 'metrics') renderMetrics(); refreshSettings(); break;
    case 'skills_pending': if (m.source && st.settings) st.settings.skills = m.source; refreshSettings(); break;
    case 'kb': st.kb = m.kb; if (st.tab === 'brain') renderBrain(); updateBadges(); break;
    case 'agent_added': { const a = m.agent; st.agents[a.id] = a; if (!st.order.includes(a.id)) st.order.push(a.id); renderer?.addAgent(a); st.hiring = m.hiring; if (st.tab === 'team') renderTeam(); break; }
    case 'agent_removed': { delete st.agents[m.id]; st.order = st.order.filter((x) => x !== m.id); delete st.live[m.id]; renderer?.removeAgent(m.id); st.hiring = m.hiring; if (st.selected === m.id) st.selected = null; if (st.tab === 'team') renderTeam(); break; }
    case 'request': { const i = st.requests.findIndex((r) => r.id === m.request.id); if (i >= 0) st.requests[i] = m.request; else st.requests.unshift(m.request); updateBadges(); if (st.tab === 'inbox' && document.activeElement?.tagName !== 'TEXTAREA') renderInbox(); break; }
    case 'requests': st.requests = m.requests; updateBadges(); if (st.tab === 'inbox') renderInbox(); break;
    case 'hr': st.hr = m.hr; if (st.tab === 'team') renderTeam(); break;
    case 'hire_request': st.pendingHires.push(m.req); if (st.tab === 'team') renderTeam(); break;
    case 'hire_resolved': st.pendingHires = st.pendingHires.filter((x) => x.id !== m.id); if (st.tab === 'team') renderTeam(); break;
    case 'deliverable_full': openDeliverable(m.deliverable); break;
    case 'skill_full': openSkill(m.skill); break;
    default: break;
  }
}

// ------------------------------------------------------------ init
function onInit(m) {
  st.init = m; st.agents = Object.fromEntries(m.agents.map((a) => [a.id, a])); st.order = m.agents.map((a) => a.id);
  st.tasks = new Map(m.tasks.map((t) => [t.id, t])); st.deliv = new Map(m.deliverables.map((d) => [d.id, d]));
  st.comms = m.comms; st.log = m.log; st.stats = m.stats; st.settings = m.settings; st.snap = m.snapshot; st.kb = m.kb; st.hiring = m.hiring; st.hr = m.hr; st.requests = m.requests || []; st.pendingHires = m.hiring?.pending || [];
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
  renderTasks(); renderComms(); renderTeam(); renderBrain(); renderOutput(); renderMetrics(); renderLog(); updateTop(); updateBadges();
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
  const live = s.mode === 'live' || s.mode === 'cli';
  $('#mode-chip').classList.toggle('live', live);
  $('#mode-label').textContent = s.mode === 'cli' ? `CLAUDE ACCOUNT · ${s.model}` : live ? `LIVE · ${s.model}` : 'SIMULATED';
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
  $('#n-inbox').textContent = st.requests.filter((r) => r.status === 'open').length || '';
}

// ------------------------------------------------------------ tabs
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; setTab(b.dataset.tab);
});
function moveTabIndicator() {
  const on = $('#tabs button.on'), ind = $('#tab-ind'); if (!on || !ind) return;
  ind.style.width = `${on.offsetWidth}px`; ind.style.transform = `translateX(${on.offsetLeft}px)`;
}
window.addEventListener('resize', moveTabIndicator); setTimeout(moveTabIndicator, 60); document.fonts?.ready.then(moveTabIndicator);
/** Count a number up to its value when a panel opens (skipped for reduced motion). */
function countUp(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $$('.tile .v', root).forEach((el) => {
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && /^\s*[\d,.]+\s*$/.test(n.textContent)); if (!node) return;
    const txt = node.textContent.trim(); const to = parseFloat(txt.replace(/,/g, '')); if (!isFinite(to) || to === 0) return;
    const dec = (txt.split('.')[1] || '').length; const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 700); const e = 1 - Math.pow(1 - k, 3); node.textContent = (to * e).toFixed(dec); if (k < 1) requestAnimationFrame(step); else node.textContent = txt; };
    requestAnimationFrame(step);
  });
}
function setTab(tab) {
  const changed = st.tab !== tab; st.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab)); moveTabIndicator();
  $$('.panel').forEach((p) => p.classList.toggle('on', p.id === `p-${tab}`));
  if (tab === 'output') { st.unreadOutput = 0; updateBadges(); }
  if (tab === 'inbox') renderInbox(); if (tab === 'team') renderTeam(); if (tab === 'brain') renderBrain(); if (tab === 'metrics') renderMetrics(); if (tab === 'log') renderLog(); if (tab === 'comms') { renderComms(); }
  if (changed && (tab === 'metrics' || tab === 'brain')) countUp($(`#p-${tab}`));
}

// ------------------------------------------------------------ tasks panel
let tasksQueued = false;
function renderTasksSoon() { if (tasksQueued) return; tasksQueued = true; setTimeout(() => { tasksQueued = false; renderTasks(); }, 120); }

function avatar(id, extra = '') {
  const a = st.agents[id]; if (id === 'god') return `<span class="av" style="background:var(--navy);color:#fff">☼</span>`;
  if (!a) return `<span class="av" style="background:#c9d5d9">?</span>`;
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
  return `${t.brief ? `<div class="plan"><b>Brief:</b> ${esc(t.brief)}</div>` : ''}${(t.warnings || []).map((w) => `<div class="notice warn">⚠ ${esc(w)}</div>`).join('')}${intakeHtml(t)}${teamHtml(t)}${t.plan ? `<div class="plan"><b>Plan:</b> ${esc(t.plan.summary)}</div>` : ''}${subs}
    <div class="row" style="margin-top:10px">${t.summaryId ? `<button class="btn primary" data-deliv="${t.summaryId}">Read executive summary</button>` : ''}${t.profileId ? `<button class="btn" data-deliv="${t.profileId}">Client profile</button>` : ''}${['failed', 'interrupted'].includes(t.status) ? `<button class="btn" data-retry="${t.id}">Retry</button>` : ''}${t.error ? `<span class="muted">${esc(t.error)}</span>` : ''}</div>`;
}

function teamHtml(t) {
  const meets = t.meetings || []; const decs = t.decisions || []; const hires = (t.hires || []).map((id) => st.agents[id]).filter(Boolean); const learned = (t.learned || []).map((id) => st.kb?.lessons?.find((l) => l.id === id)).filter(Boolean);
  if (!meets.length && !hires.length && !learned.length) return '';
  const ico = { kickoff: '🚀', alignment: '⚖', retro: '🔁' };
  const mh = meets.map((m) => `<details class="meet"><summary><span>${ico[m.type] || '💬'} ${esc(m.title)}</span><span class="avatars">${m.participants.slice(0, 8).map((p) => avatar(p)).join('')}</span></summary>
      <div class="turns">${m.turns.map((x) => `<div class="turn">${avatar(x.agent)}<div><b>${esc(nm(x.agent))}</b> ${esc(x.text)}</div></div>`).join('') || '<div class="muted">In progress…</div>'}</div></details>`).join('');
  return `<div class="intake">
    ${hires.length ? `<div class="ih">Hired for this task</div>${hires.map((h) => `<div class="srcline">${avatar(h.id)} <b>${esc(h.name)}</b>, ${esc(h.role)}${h.why ? ` — ${esc(h.why)}` : ''}</div>`).join('')}` : ''}
    ${meets.length ? `<div class="ih">Meetings</div>${mh}` : ''}
    ${decs.length ? `<div class="ih q">Decisions</div><ul class="finds">${decs.map((d) => `<li><b>${esc(d.issue)}</b><br>${esc(d.decision)}</li>`).join('')}</ul>` : ''}
    ${t.retro ? `<div class="ih">Retrospective</div><ul class="finds">${[...(t.retro.wentWell || []).map((x) => `✓ ${x}`), ...(t.retro.wentWrong || []).map((x) => `✗ ${x}`)].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${learned.length ? `<div class="ih">What the team learned from this</div><ul class="finds">${learned.slice(0, 8).map((l) => `<li>${esc(l.text)} <span class="muted">(${esc(l.scope)}, ${esc(l.source)})</span></li>`).join('')}</ul>` : ''}</div>`;
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
  const taskOpts = `<option value="all">All tasks</option>${[...st.tasks.values()].sort((a, b) => b.created - a.created).map((t) => `<option value="${t.id}" ${st.commsTask === t.id ? 'selected' : ''}>${t.id} ${esc(t.title.slice(0, 28))}</option>`).join('')}`;
  p.innerHTML = `<div class="filters">${btn('all', 'All')}${btn('work', 'Work')}${btn('meet', 'Meetings')}${btn('talk', 'Talk')}${btn('research', 'Research')}${btn('banter', 'Banter')}${btn('god', 'God')}<select id="c-task" class="minisel">${taskOpts}</select></div><div id="feed"></div>`;
  $('#c-task', p).onchange = (e) => { st.commsTask = e.target.value; renderComms(); };
  $$('.filters button', p).forEach((b) => (b.onclick = () => { st.commsFilter = b.dataset.f; renderComms(); }));
  const feed = $('#feed', p);
  const msgs = st.comms.filter(passes).slice(-160);
  feed.innerHTML = msgs.length ? msgs.map(msgHtml).join('') : `<div class="empty">Nothing here yet.</div>`;
  p.scrollTop = p.scrollHeight;
}
function passes(m) {
  const f = st.commsFilter;
  if (st.commsTask !== 'all' && m.taskId !== st.commsTask) return false;
  if (f === 'all') return true; if (f === 'work') return m.kind === 'task'; if (f === 'meet') return ['kickoff', 'retro', 'decision', 'question'].includes(m.kind);
  if (f === 'talk') return ['consult', 'review', 'handoff', 'status', 'hire'].includes(m.kind); if (f === 'research') return m.kind === 'research';
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

// ------------------------------------------------------------ inbox: what the agents need from God
function renderInbox() {
  const p = $('#p-inbox'); const all = st.requests; const open = all.filter((r) => r.status === 'open'); const done = all.filter((r) => r.status !== 'open');
  if (!all.length) { p.innerHTML = '<div class="empty"><div class="big">📥</div>Nothing needed yet. When an agent cannot find a document, a data export or an answer itself, it asks here, and carries on with assumptions meanwhile.</div>'; return; }
  const kind = (k) => `<span class="pill kind-${k}">${esc(k)}</span>`;
  const card = (r) => {
    const a = st.agents[r.by]; const ans = r.answer;
    const head = `<div class="rq-head">${avatar(r.by)}<b>${esc(a?.short || r.by)}</b>${kind(r.kind)}${r.taskId ? `<span class="pill">${esc(r.taskId)}</span>` : ''}${r.auto ? `<span class="pill auto">found in connected tools</span>` : ''}<span class="muted" style="margin-left:auto;font-size:11px">${esc(r.id)}</span></div>`;
    const body = `<div class="rq-what">${esc(r.what)}</div>${r.why ? `<div class="rq-why">${esc(r.why)}</div>` : ''}${r.tried ? `<div class="rq-tried">Already tried: ${esc(r.tried)}</div>` : ''}`;
    if (r.status !== 'open') return `<div class="card req ${r.status}">${head}${body}<div class="rq-ans">${r.status === 'declined' ? 'You said you cannot provide this.' : `${esc(ans.by !== 'god' ? `From ${ans.by.replace('connector: ', '')}:\n` : '')}${esc(ans.text.slice(0, 600))}${ans.text.length > 600 ? '…' : ''}`}</div>${ans?.files?.length ? `<div class="rq-files">Attached: ${ans.files.map((f) => esc(f.name)).join(', ')}</div>` : ''}</div>`;
    const files = (st.rqFiles[r.id] || []).map((f) => esc(f.name)).join(', ');
    return `<div class="card req">${head}${body}<textarea data-rq-text="${r.id}" placeholder="Type the answer, or paste the data here…"></textarea><div class="rq-actions"><button class="btn primary sm" data-rq-send="${r.id}">Send answer</button><label class="btn sm" style="cursor:pointer">Attach files<input type="file" multiple hidden data-rq-file="${r.id}" accept=".txt,.md,.csv,.tsv,.json,.html,.xml,.log,text/*"></label><button class="btn sm" data-rq-no="${r.id}">Can't provide</button><span class="rq-files" data-rq-files="${r.id}">${files}</span></div></div>`;
  };
  // tasks with answers that have not been applied yet
  const apply = [...new Set(all.filter((r) => r.status === 'answered' && !r.appliedAt && r.taskId).map((r) => r.taskId))].map((id) => {
    const n = all.filter((r) => r.taskId === id && r.status === 'answered' && !r.appliedAt).length; const t = st.tasks.get(id);
    return t && ['done', 'failed'].includes(t.status) ? `<div class="apply-bar"><span>${esc(id)}: ${n} answer${n > 1 ? 's' : ''} not applied yet</span><button class="btn primary sm" data-rq-apply="${id}">Apply answers</button></div>` : '';
  }).join('');
  p.innerHTML = `${apply}${open.length ? `<h3 class="sect">Needs you (${open.length})</h3>${open.map(card).join('')}` : '<div class="empty" style="padding:18px"><div class="big">✅</div>Nothing is waiting on you.</div>'}${done.length ? `<h3 class="sect">Answered</h3>${done.slice(0, 30).map(card).join('')}` : ''}`;
  $$('[data-rq-send]', p).forEach((b) => (b.onclick = () => { const id = b.dataset.rqSend; send({ type: 'answerRequest', id, text: $(`[data-rq-text="${id}"]`, p).value, files: st.rqFiles[id] || [] }); delete st.rqFiles[id]; }));
  $$('[data-rq-no]', p).forEach((b) => (b.onclick = () => send({ type: 'answerRequest', id: b.dataset.rqNo, decline: true })));
  $$('[data-rq-apply]', p).forEach((b) => (b.onclick = () => { b.disabled = true; b.textContent = 'Applying…'; send({ type: 'applyAnswers', taskId: b.dataset.rqApply }); }));
  $$('[data-rq-file]', p).forEach((inp) => (inp.onchange = async () => {
    const id = inp.dataset.rqFile; const out = [];
    for (const f of [...inp.files].slice(0, 5)) { if (f.size > 400000) { toast(`${f.name} is over 400 KB. Paste the relevant part instead.`, 'warn'); continue; } out.push({ name: f.name, text: await f.text() }); }
    st.rqFiles[id] = out; $(`[data-rq-files="${id}"]`, p).textContent = out.map((f) => f.name).join(', ');
  }));
}

// ------------------------------------------------------------ team panel
function hrPanel() {
  const h = st.hr; if (!h) return '';
  const rel = (h.releases || []).filter((r) => r.status === 'pending').map((r) => `<div class="card hirereq"><b>Nia proposes releasing ${esc(r.name)}</b><div class="muted">${esc(r.reason)}</div><div class="row" style="margin-top:6px"><button class="btn primary sm" data-rd="${r.id}" data-ok="1">Approve release</button><button class="btn sm" data-rd="${r.id}" data-ok="0">Keep</button></div></div>`).join('');
  const rep = (h.reports || [])[0]; const revs = (h.reviews || []).slice(0, 4);
  return `${rel}<details class="card"><summary><b>People &amp; Talent</b> <span class="muted">· ${h.facts.headcount}/${h.facts.caps.headcount} desks · ${h.facts.hiredNow}/${h.facts.caps.total} hires used · ${h.facts.unowned.marketing} marketing and ${h.facts.unowned.hr} HR library skills unowned</span></summary>
    <div class="row" style="margin:6px 0"><button class="btn sm" id="hr-report">Workforce report</button><button class="btn sm" id="hr-reviews">Review everyone</button></div>
    ${rep ? `<div class="muted" style="font-size:12px">Latest report: ${esc(new Date(rep.at).toLocaleString())} · ${esc(rep.recommendations[0] || '')}</div>` : '<div class="muted" style="font-size:12px">No workforce report yet. One is written every five finished tasks.</div>'}
    ${revs.map((r) => `<div style="margin-top:6px;font-size:12px"><b>${esc(r.name)}</b> <span class="pill">${esc(r.rating)}</span><div class="muted">${esc(r.narrative)}</div></div>`).join('')}
    ${(h.skillNotes || []).slice(0, 2).map((n) => `<div class="muted" style="font-size:11.5px;margin-top:4px">${esc(n.text)}</div>`).join('')}</details>`;
}
function renderTeam() {
  const p = $('#p-team'); const byDept = {};
  for (const id of st.order) (byDept[st.agents[id].dept] ||= []).push(id);
  const h = st.hiring;
  const pend = (st.pendingHires || []).map((r) => `<div class="card hirereq"><b>${esc(st.agents[r.by]?.short || r.by)} wants to hire a ${esc(r.role)}</b><div class="muted">${esc(r.why)}</div><div class="muted">Skills: ${esc((r.skills || []).join(', '))}</div><div class="row" style="margin-top:6px"><button class="btn primary sm" data-hd="${r.id}" data-ok="1">Approve</button><button class="btn sm" data-hd="${r.id}" data-ok="0">Decline</button></div></div>`).join('');
  const kids = (id) => st.order.filter((x) => st.agents[x].reportsTo === id);
  const node = (id, depth = 0) => `<div class="org" style="margin-left:${depth * 14}px" data-sel="${id}">${avatar(id)}<b>${esc(st.agents[id].short)}</b><span class="muted">${esc(st.agents[id].role)}</span>${st.agents[id].hired ? '<em class="tagnew">hired</em>' : ''}</div>${kids(id).map((k) => node(k, depth + 1)).join('')}`;
  p.innerHTML = `${pend}${hrPanel()}<div class="card"><div class="row" style="justify-content:space-between"><div><b>${h ? h.headcount : st.order.length} people</b> <span class="muted">· ${h ? h.hired : 0} hired · ${h ? h.freeDesks : 0} free desks in the Annex · hiring: ${esc(st.settings?.hiring || 'auto')}</span></div><button class="btn sm" id="t-hire">+ Hire someone</button></div>
    <details class="orgchart"><summary>Org chart</summary>${st.order.filter((id) => !st.agents[id].reportsTo).map((id) => node(id)).join('')}</details></div>`
    + Object.entries(byDept).map(([d, ids]) => `<div class="dept-title" style="color:${st.init.depts[d].color}"><i style="background:${st.init.depts[d].color}"></i>${esc(st.init.depts[d].label)}</div>` + ids.map((id) => {
      const a = st.agents[id]; const rep = a.reportsTo ? st.agents[a.reportsTo]?.short : null;
      return `<div class="person" data-id="${id}"><canvas width="48" height="72" data-av="${id}"></canvas><div><div class="nm">${esc(a.name)} ${a.lead ? '<em class="taglead">lead</em>' : ''}${a.hired ? '<em class="tagnew">hired</em>' : ''}</div><div class="rl">${esc(a.role)}${rep ? ` · reports to ${esc(rep)}` : ''}</div><div class="st" data-st="${id}"></div>
      <div class="bars"><span>EN</span><div class="bar en"><i data-en="${id}"></i></div><span>MO</span><div class="bar mo"><i data-mo="${id}"></i></div></div></div></div>`;
    }).join('')).join('');
  $$('canvas[data-av]', p).forEach((c) => { const a = st.agents[c.dataset.av]; const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(personFrame(a.id, a.look, 'down', 'stand', 0), 0, 0, 48, 72); });
  $$('.person', p).forEach((c) => (c.onclick = () => { selectAgent(c.dataset.id, { focus: true, open: true }); }));
  $$('[data-sel]', p).forEach((c) => (c.onclick = () => selectAgent(c.dataset.sel, { focus: true })));
  $$('[data-hd]', p).forEach((b) => (b.onclick = () => send({ type: 'hireDecision', id: b.dataset.hd, ok: b.dataset.ok === '1' })));
  $$('[data-rd]', p).forEach((b) => (b.onclick = () => send({ type: 'releaseDecision', id: b.dataset.rd, ok: b.dataset.ok === '1' })));
  const hrr = $('#hr-report', p); if (hrr) hrr.onclick = () => send({ type: 'hrReport' }); const hrv = $('#hr-reviews', p); if (hrv) hrv.onclick = () => send({ type: 'hrReviewAll' });
  $('#t-hire', p).onclick = () => openHireForm();
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

// ------------------------------------------------------------ brain (what the company has learned)
function renderBrain() {
  const p = $('#p-brain'); const kb = st.kb; if (!kb) return;
  const sm = kb.summary; const ap = sm.approval; const mode = st.settings?.learning || sm.mode;
  const pct = (v, n) => (v == null ? '–' : `${v}%`) + (n ? ` <small>n=${n}</small>` : '');
  const f = st.brainFilter; const q = st.brainQuery.toLowerCase();
  const lessons = kb.lessons.filter((l) => (f === 'all' || (f === 'web' ? l.unverified : f === 'pinned' ? l.pinned : l.scope === f)) && (!q || l.text.toLowerCase().includes(q) || (l.skill || '').includes(q)));
  const chip = (k, t) => `<button data-bf="${k}" class="${f === k ? 'on' : ''}">${t}</button>`;
  const learnHelp = { active: 'Learns from reviews, retrospectives and by studying the web in idle time.', passive: 'Learns from reviews and retrospectives only. No web study.', off: 'Nothing is recorded or injected.' }[mode];
  p.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="k">Lessons</div><div class="v">${sm.active}</div></div><div class="tile"><div class="k">Avg. score</div><div class="v">${Math.round(sm.avgScore * 100)}<small>%</small></div></div><div class="tile"><div class="k">Playbooks</div><div class="v">${sm.playbooks}</div></div>
      <div class="tile"><div class="k">Promoted</div><div class="v">${sm.promoted}</div></div><div class="tile"><div class="k">Retired</div><div class="v">${sm.retired}</div></div><div class="tile"><div class="k">Studied</div><div class="v">${sm.studySessions}</div></div>
    </div>
    <div class="card" style="margin-top:10px"><div class="k muted" style="font:10px var(--mono);letter-spacing:1px;text-transform:uppercase">Does learning help? First-pass approval</div>
      <div class="row" style="gap:18px;margin-top:4px"><div>With lessons applied <b style="font-size:18px">${pct(ap.withLessons, ap.nWith)}</b></div><div>Without <b style="font-size:18px">${pct(ap.without, ap.nWithout)}</b></div></div>
      <div class="muted" style="font-size:11px;margin-top:4px">Measured on real reviews. Treat it as a trend once each side has 10 or more.</div></div>
    <div class="card"><div class="row" style="justify-content:space-between"><b>Learning: ${esc(mode)}</b><span class="seg" id="b-mode">${['active', 'passive', 'off'].map((m) => `<button data-m="${m}" class="${m === mode ? 'on' : ''}">${m}</button>`).join('')}</span></div><div class="muted" style="margin-top:6px;font-size:12px">${esc(learnHelp)} Lessons are scored by whether the work they influenced was approved: useful ones are promoted from you to your team to the company, weak ones are retired, and clusters become house playbooks. Ideas from the web stay unverified until they help.</div></div>
    ${sm.sources?.length ? `<h3 class="sect">Which kinds of lessons help <span class="muted">· the system learns how to learn</span></h3>${sm.sources.map((x) => `<div class="drow"><span>${esc(x.source)}</span><div class="bar mo"><i style="width:${x.rate}%"></i></div><span class="n">${x.rate}% · ×${x.weight}</span></div>`).join('')}<div class="muted" style="font-size:11.5px;margin:4px 0 8px">Share of approved work that each kind of lesson influenced, and the weight it now gets when lessons are chosen. Studying the web runs at ×${sm.studyFactor} of its normal rate.</div>` : ''}
    ${kb.events.length ? `<h3 class="sect">Recent learning</h3>${[...kb.events].reverse().slice(0, 5).map((e) => `<div class="log"><span class="tm">${timeStr(e.t)}</span><span>${esc(e.text)}</span></div>`).join('')}` : ''}
    <h3 class="sect">Lessons</h3>
    <div class="filters" style="position:static;margin:0 0 8px;padding:0">${chip('all', 'All')}${chip('company', 'Company')}${chip('team', 'Team')}${chip('agent', 'Individual')}${chip('client', 'Client')}${chip('web', 'Unverified')}${chip('pinned', 'Pinned')}</div>
    <input class="search" id="b-q" placeholder="Search lessons…" value="${esc(st.brainQuery)}" />
    ${lessons.length ? lessons.slice(0, 80).map((l) => `<div class="card lesson ${l.unverified ? 'unv' : ''}"><div class="txt">${esc(l.text)}</div>
        <div class="tagrow">${l.agent ? avatar(l.agent) : ''}<span class="pill">${esc(l.scope)}${l.kind === 'rule' ? ' rule' : ''}</span><span class="pill">${esc(l.source)}</span>${l.skill ? `<span class="pill">${esc(l.skill)}</span>` : ''}${l.unverified ? '<span class="pill sim">unverified</span>' : ''}${l.pinned ? '<span class="pill sum">pinned</span>' : ''}<span>used ${l.uses.toFixed(1)}× · won ${l.wins.toFixed(1)}</span></div>
        <div class="row" style="justify-content:space-between;margin-top:6px"><div class="progress" style="flex:1;margin:0"><i style="width:${Math.round(l.score * 100)}%"></i></div><span class="muted" style="font:11px var(--mono)">${Math.round(l.score * 100)}%</span><button class="btn sm" data-pin="${l.id}">${l.pinned ? 'Unpin' : 'Pin'}</button><button class="btn sm" data-forget="${l.id}">Forget</button></div></div>`).join('') : '<div class="empty">No lessons here yet. They appear after reviews and retrospectives.</div>'}
    ${Object.keys(kb.playbooks).length ? `<h3 class="sect">House playbooks</h3>${Object.values(kb.playbooks).map((pb) => `<div class="card"><b>${esc(pb.skill)}</b> <span class="muted">v${pb.version} · used ${pb.uses} · approved ${pb.wins}</span><div class="md">${md(pb.text)}</div></div>`).join('')}` : ''}
    ${kb.notes.length ? `<h3 class="sect">Reading list <span class="muted">· what agents studied on the web</span></h3>${kb.notes.slice(0, 12).map((n) => `<div class="card"><div class="tagrow">${avatar(n.agent)}<span class="pill">${esc(n.skill)}</span></div>${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--cyan)">${esc(n.title)}</a>` : esc(n.title)}${n.headings?.length ? `<div class="muted" style="font-size:11.5px;margin-top:3px">${n.headings.map(esc).join(' · ')}</div>` : ''}${n.note ? `<div class="muted" style="font-size:11.5px">${esc(n.note)}</div>` : ''}</div>`).join('')}` : ''}`;
  $$('[data-bf]', p).forEach((b) => (b.onclick = () => { st.brainFilter = b.dataset.bf; renderBrain(); }));
  $('#b-q', p).oninput = (e) => { st.brainQuery = e.target.value; const pos = e.target.selectionStart; renderBrain(); const n = $('#b-q'); n.focus(); n.setSelectionRange(pos, pos); };
  $$('[data-pin]', p).forEach((b) => (b.onclick = () => { const l = kb.lessons.find((x) => x.id === b.dataset.pin); send({ type: 'kbPin', id: b.dataset.pin, value: !l?.pinned }); }));
  $$('[data-forget]', p).forEach((b) => (b.onclick = () => send({ type: 'kbForget', id: b.dataset.forget })));
  $$('#b-mode button', p).forEach((b) => (b.onclick = () => send({ type: 'setLearning', value: b.dataset.m })));
}

function openHireForm() {
  const skills = st.init.skills.map((k) => k.name);
  openModal(`<button class="btn close">✕</button><h2>Hire someone</h2><div class="muted">They get a desk in the Annex and join the team. The CMO and the leads can also hire when a task needs it (hiring mode: ${esc(st.settings?.hiring || 'auto')}).</div>
    <form id="hire-form"><label class="field-label">Job title</label><input class="field" id="h-role" maxlength="60" placeholder="e.g. Marine Industry Strategist (optional when a library playbook is matched)" />
    <label class="field-label">Describe what is needed <span class="muted">(the matching playbooks are found in the skills library, which is checked for updates first)</span></label><textarea class="field" id="h-need" rows="2" maxlength="300" placeholder="e.g. marketing for shipping and marine logistics companies"></textarea>
    <label class="field-label">…or name the skills (comma separated, optional)</label><input class="field" id="h-skills" list="h-skill-list" placeholder="customer-research, competitors" /><datalist id="h-skill-list">${skills.map((k) => `<option value="${k}">`).join('')}</datalist>
    <label class="field-label">Domain (optional, one word)</label><input class="field" id="h-domain" maxlength="24" placeholder="marine" />
    <label class="field-label">Why</label><textarea class="field" id="h-why" rows="2" maxlength="240" placeholder="What the team is missing"></textarea>
    <div class="row" style="margin-top:14px"><button class="btn primary">Hire</button></div></form>`, 'hire');
  $('#hire-form').onsubmit = (e) => { e.preventDefault(); const role = $('#h-role').value.trim(), need = $('#h-need').value.trim(), skills = $('#h-skills').value.split(/[,\s]+/).filter(Boolean); if (!skills.length && !need) { toast('Describe the need or name at least one skill.', 'warn'); return; } send({ type: 'hire', role, need, skills, why: $('#h-why').value.trim(), domain: $('#h-domain').value.trim() || null }); closeModal(); };
}

// ------------------------------------------------------------ output panel
let outQueued = false;
function renderOutputSoon() { if (outQueued) return; outQueued = true; setTimeout(() => { outQueued = false; renderOutput(); }, 150); }
function renderOutput() {
  const p = $('#p-output');
  const list = [...st.deliv.values()].sort((a, b) => b.created - a.created);
  if (!list.length) { p.innerHTML = `<div class="empty"><div class="big">📄</div>Deliverables from the team will appear here, each saved as Markdown in <code>deliverables/</code>.</div>`; return; }
  p.innerHTML = list.map((d) => `<div class="card deliv" data-id="${d.id}"><div class="tagrow">${avatar(d.agent)}<span class="pill ${d.kind === 'summary' || d.kind === 'profile' || d.kind === 'hr' ? 'sum' : ''}">${d.kind === 'summary' ? 'executive summary' : d.kind === 'profile' ? 'client profile' : d.kind === 'hr' ? 'workforce report' : esc(d.skill)}</span><span class="pill">${d.taskId}</span>${d.simulated ? '<span class="pill sim">simulated</span>' : ''}<span>${d.words} words</span></div><div class="t">${esc(d.title)}</div><div class="pv">${esc(d.preview)}</div></div>`).join('');
  $$('.deliv', p).forEach((c) => (c.onclick = () => send({ type: 'deliverable', id: c.dataset.id })));
}

// ------------------------------------------------------------ metrics panel
function renderMetrics() {
  const p = $('#p-metrics'); const s = st.stats; if (!s) return;
  const t = s.llm.totals; const live = s.llm.mode !== 'mock';
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
      ${tile('People', s.hiring?.headcount ?? '', `${s.hiring?.hired ?? 0} hired`)}${tile('Lessons', s.learning?.active ?? 0, `${s.learning?.playbooks ?? 0} playbooks`)}${tile('Study', s.learning?.studySessions ?? 0, 'sessions')}
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
    <h2>${esc(a.name)} ${a.lead ? '<em class="taglead">lead</em>' : ''}${a.hired ? '<em class="tagnew">hired</em>' : ''}</h2><div class="muted">${esc(a.role)} · ${esc(st.init.depts[a.dept]?.label || a.dept)}${a.reportsTo ? ` · reports to ${esc(st.agents[a.reportsTo]?.name || a.reportsTo)}` : ''}${a.domains?.length ? ` · domain: ${esc(a.domains.join(', '))}` : ''}</div>
    <p>${esc(a.persona)}</p><div id="insp-live" class="notice"></div>
    <div class="row"><button class="btn" id="i-follow">Follow</button><button class="btn" id="i-bless">✨ Bless</button><button class="btn" id="i-smite">⚡ Smite (lightly)</button><button class="btn primary" id="i-task">Assign task</button>${a.hired ? '<button class="btn" id="i-fire">Let go</button>' : ''}</div></div></div>
    <h3 class="sect" style="margin-top:18px">Skills</h3><div class="chips">${a.skills.map((k) => `<span class="skill" data-skill="${k}">${k}</span>`).join('')}</div>
    <h3 class="sect">Talk to ${esc(a.short)}</h3><form class="row" id="i-chat"><input class="field" style="flex:1" id="i-chat-text" placeholder="Say something to ${esc(a.short)}…" maxlength="500"/><button class="btn">Send</button></form><div id="i-reply" class="muted" style="margin-top:6px"></div>
    ${a.jd ? `<h3 class="sect">Job description</h3><div class="md">${md(a.jd)}</div><h3 class="sect">30/60/90 plan</h3>${(a.onboarding || []).map((p) => `<div class="srcline"><b>${esc(p.phase)}</b>: ${esc(p.goals.join('; '))}</div>`).join('')}` : ''}
    ${(st.hr?.reviews || []).filter((r) => r.agent === a.id).slice(0, 2).map((r) => `<h3 class="sect">Performance review <span class="pill">${esc(r.rating)}</span></h3><div class="muted">${esc(r.narrative)}</div><div class="muted" style="font-size:11px">${esc(r.factLines.join(' · '))}</div>`).join('')}
    <h3 class="sect">What ${esc(a.short)} has learned</h3><div id="insp-les"></div><h3 class="sect">Memory</h3><div id="insp-mem"></div>`, 'agent');
  const fire = $('#i-fire'); if (fire) fire.onclick = () => { if (confirm(`Let ${a.name} go? What they learned stays with the team.`)) { send({ type: 'fire', id }); closeModal(); } };
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
  const les = $('#insp-les'); if (les) { const mine = (st.kb?.lessons || []).filter((l) => l.agent === id).slice(0, 6); les.innerHTML = mine.length ? mine.map((l) => `<div class="mem">${esc(l.text)} <span class="muted">(${Math.round(l.score * 100)}%${l.unverified ? ', unverified' : ''})</span></div>`).join('') : '<div class="muted">Nothing yet. Lessons appear after reviews.</div>'; }
  const last = [...st.comms].reverse().find((m) => m.kind === 'dm' && m.from === id);
  const rep = $('#i-reply'); if (rep && last && !rep.textContent.endsWith('thinking…')) rep.innerHTML = `<b style="color:${a.color}">${esc(a.short)}:</b> ${esc(last.text)}`;
  else if (rep && last && rep.textContent.endsWith('thinking…') && last.wall > (rep._t || 0)) { rep.innerHTML = `<b style="color:${a.color}">${esc(a.short)}:</b> ${esc(last.text)}`; }
}

function refreshSettings() { if (!$('#modal').hidden && $('#modal-card').dataset.kind === 'settings') openSettings(); }

function openSettings() {
  const s = st.settings; if (!s) return;
  openModal(`<button class="btn close">✕</button><h2>Settings</h2><div class="muted">How the agents think.</div>
    ${modeNotice(s)}
    <label class="field-label">Anthropic API key ${s.hasKey ? '<span style="color:var(--green)">· set (held in server memory only)</span>' : ''}</label>
    <div class="row"><input class="field" style="flex:1" id="s-key" type="password" placeholder="${s.hasKey ? '•••••••• (leave blank to keep)' : 'sk-ant-…'}" autocomplete="off" /><button class="btn primary" id="s-save">${s.hasKey ? 'Update & go live' : 'Save & go live'}</button></div>
    <label class="field-label">Model</label><div class="row"><input class="field" style="flex:1" id="s-model" value="${esc(s.model)}" /><button class="btn" id="s-model-save">Set</button></div>
    <label class="field-label">Budget cap (USD, estimated)</label><div class="row"><input class="field" style="flex:1" id="s-budget" type="number" min="0.1" step="0.5" value="${s.budgetCap}" /><button class="btn" id="s-budget-save">Set</button></div>
    <label class="field-label">Team conversation (cost vs. realism)</label><div class="row">${['full', 'lean', 'off'].map((m) => `<button class="btn ${s.collab === m ? 'primary' : ''}" data-collab="${m}">${m}</button>`).join('')}</div><div class="muted" style="font-size:11.5px;margin-top:4px">full: kickoff, handoffs, consults, alignment meetings. lean: fewer calls. off: agents just work. Each conversation turn is a small model call in live mode.</div>
    <label class="field-label">Hiring</label><div class="row">${['auto', 'ask', 'off'].map((m) => `<button class="btn ${s.hiring === m ? 'primary' : ''}" data-hiring="${m}">${m}</button>`).join('')}</div><div class="muted" style="font-size:11.5px;margin-top:4px">auto: the CMO and agents hire within the caps. ask: you approve each hire. off: no hiring.</div>
    <label class="field-label">Learning</label><div class="row">${['active', 'passive', 'off'].map((m) => `<button class="btn ${s.learning === m ? 'primary' : ''}" data-learning="${m}">${m}</button>`).join('')}</div><div class="muted" style="font-size:11.5px;margin-top:4px">active: also studies the web in idle time. passive: reviews and retrospectives only. off: nothing recorded.</div>
    ${skillsBlock(s)}
    <label class="field-label">Mode</label><div class="modes"><button class="btn ${s.mode === 'mock' ? 'primary' : ''}" id="s-mock">Simulated</button><button class="btn ${s.mode === 'live' ? 'primary' : ''}" id="s-live" ${s.hasKey ? '' : 'disabled'}>API key</button><button class="btn ${s.mode === 'cli' ? 'primary' : ''}" id="s-cli" ${s.cli?.available || !s.cli?.checked ? '' : 'disabled'}>Claude account</button></div>
    ${connectorsBlock(s)}
    ${s.lastError ? `<div class="notice warn">Last API error: ${esc(s.lastError)}</div>` : ''}
    <div class="notice" style="margin-top:16px">Prices used for cost estimates: $${s.price.in}/M input, $${s.price.out}/M output tokens (override with the <code>PRICE_IN</code> / <code>PRICE_OUT</code> env vars). Your key is never written to disk; you can also set <code>ANTHROPIC_API_KEY</code> before starting the server.</div>`, 'settings');
  $('#s-save').onclick = () => { const key = $('#s-key').value.trim(); if (!key && !s.hasKey) return; send({ type: 'setKey', key: key || undefined, useLive: true }); if (!key) send({ type: 'setMode', mode: 'live' }); };
  $('#s-model-save').onclick = () => send({ type: 'setModel', model: $('#s-model').value });
  $('#s-budget-save').onclick = () => send({ type: 'setBudget', value: $('#s-budget').value });
  $$('[data-skmode]', card).forEach((b) => (b.onclick = () => send({ type: 'setSkillsMode', value: b.dataset.skmode }))); $$('[data-sk-check]', card).forEach((b) => (b.onclick = () => { b.textContent = 'Checking…'; send({ type: 'skillsCheck', id: b.dataset.skCheck }); })); $$('[data-sk-rollback]', card).forEach((b) => (b.onclick = () => { if (confirm('Roll this skills library back to the previous version?')) send({ type: 'skillsRollback', id: b.dataset.skRollback }); })); $$('[data-sk-approve]', card).forEach((b) => (b.onclick = () => send({ type: 'skillsApprove', id: b.dataset.skApprove }))); $$('[data-sk-decline]', card).forEach((b) => (b.onclick = () => send({ type: 'skillsDecline', id: b.dataset.skDecline })));
  $$('[data-collab]', card).forEach((b) => (b.onclick = () => send({ type: 'setCollab', value: b.dataset.collab }))); $$('[data-hiring]', card).forEach((b) => (b.onclick = () => send({ type: 'setHiring', value: b.dataset.hiring }))); $$('[data-learning]', card).forEach((b) => (b.onclick = () => send({ type: 'setLearning', value: b.dataset.learning })));
  $('#s-mock').onclick = () => send({ type: 'setMode', mode: 'mock' }); $('#s-live').onclick = () => send({ type: 'setMode', mode: 'live' }); $('#s-cli').onclick = () => send({ type: 'setMode', mode: 'cli' });
  const scan = $('#cli-scan'); if (scan) scan.onclick = () => { scan.textContent = 'Scanning…'; scan.disabled = true; send({ type: 'cliScan' }); };
  $$('[data-conn]', card).forEach((b) => (b.onclick = () => send({ type: 'cliConnector', name: b.dataset.conn, on: b.dataset.on === '1' })));
}

function modeNotice(s) {
  if (s.mode === 'cli') return `<div class="notice"><b>Claude account.</b> The agents run through your signed-in Claude CLI${s.cli?.version ? ` (${esc(s.cli.version)})` : ''}: your account's web search and the connectors you switch on below. No API key is used. Spend is capped at $${s.budgetCap} (estimated).</div>`;
  if (s.mode === 'live') return `<div class="notice"><b>API key.</b> Real Claude (${esc(s.model)}) is running the agents with your key. Agents can search the web and read pages, but cannot use your Claude account's connectors in this mode. Spend is capped at $${s.budgetCap}.</div>`;
  return `<div class="notice warn"><b>Simulated.</b> The office runs on a built-in simulator so you can see everything work without a key. Deliverables are stamped SIMULATED. Use an API key or your Claude account to make the agents really think.</div>`;
}
function connectorsBlock(s) {
  const c = s.cli; if (!c) return '';
  if (!c.available) return `<div class="notice" style="margin-top:10px"><b>Claude account.</b> ${c.checked ? esc(c.error || 'The Claude CLI is not available.') : 'Checking for the Claude CLI…'} Install Claude Code, sign in with your account, then reopen Settings.</div>`;
  const rows = c.servers.map((v) => `<div class="conn"><div><b>${esc(v.name)}</b><small>${v.readOnlyTools.length} read-only tool${v.readOnlyTools.length === 1 ? '' : 's'} usable${v.blockedTools ? ` · ${v.blockedTools} blocked (can write or act)` : ''}</small></div>${v.readOnlyTools.length ? `<button class="btn sm ${v.enabled ? 'primary' : ''}" data-conn="${esc(v.name)}" data-on="${v.enabled ? 0 : 1}">${v.enabled ? 'On' : 'Off'}</button>` : '<span class="muted" style="font-size:11px">cannot enable</span>'}</div>`).join('');
  return `<label class="field-label">Connectors on your Claude account <span class="muted">· off until you switch them on</span></label>
    <div class="muted" style="font-size:11.5px;margin-bottom:4px">When on, agents may <b>read</b> from a connector (for example your notes or documents) to find what they need before asking you. Tools that send, create, change, delete or spend are always blocked. Connector content is treated as untrusted data.</div>
    ${rows || '<div class="notice">No connectors found yet. Scan to look.</div>'}
    <div class="row" style="margin-top:8px"><button class="btn sm" id="cli-scan">Scan connectors</button><span class="muted" style="font-size:11px">${c.scannedAt ? `Last scanned ${esc(new Date(c.scannedAt).toLocaleString())}` : 'Not scanned yet'}${c.plugins?.length ? ` · plugins: ${esc(c.plugins.join(', '))}` : ''}</span></div>`;
}

function skillsBlock(s) {
  const libs = [].concat(s.skills || []); if (!libs.length) return '';
  const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const name = { marketing: 'Marketing skills', hr: 'HR skills' };
  const one = (k) => {
    const pend = k.pending;
    return `<div class="notice" style="margin-top:6px"><b>${esc(name[k.id] || k.id)}</b> · ${esc(k.repo)} (${esc(k.branch)}). Commit <code>${esc(k.commit || 'unknown')}</code>${k.vendoredCommit && k.commit !== k.vendoredCommit ? ` (shipped with <code>${esc(k.vendoredCommit)}</code>)` : ''} · ${k.skillCount} skills · synced ${esc(when(k.syncedAt))} · checked ${esc(when(k.checkedAt))}.
      ${k.lastError ? `<div style="color:#ffb4a0;margin-top:4px">Last check failed: ${esc(k.lastError)}</div>` : ''}</div>
    ${pend ? `<div class="notice warn"><b>${esc(name[k.id] || k.id)} update available</b> (<code>${esc(pend.commit)}</code>): ${pend.added.length} new${pend.added.length ? ` (${esc(pend.added.slice(0, 6).join(', '))})` : ''}, ${pend.changed.length} changed${pend.changed.length ? ` (${esc(pend.changed.slice(0, 6).join(', '))})` : ''}. <div class="row" style="margin-top:6px"><button class="btn primary sm" data-sk-approve="${esc(k.id)}">Approve</button><button class="btn sm" data-sk-decline="${esc(k.id)}">Decline</button></div></div>` : ''}
    <div class="row" style="margin-top:4px"><button class="btn sm" data-sk-check="${esc(k.id)}">Check ${esc(k.id)} now</button><button class="btn sm" data-sk-rollback="${esc(k.id)}" ${k.canRollback ? '' : 'disabled'}>Roll back ${esc(k.id)}</button></div>`;
  };
  const mode = libs[0].mode;
  return `<label class="field-label">Skills libraries <span class="muted">· specialists are built from them</span></label>
    <div class="row">${['auto', 'ask', 'off'].map((m) => `<button class="btn ${mode === m ? 'primary' : ''}" data-skmode="${m}">${m}</button>`).join('')}</div>
    <div class="muted" style="font-size:11.5px;margin:4px 0">Each library is checked before every hire and every few hours. Updates are stored apart from the project files and can be rolled back. Skill text becomes part of agent prompts, so use <b>ask</b> to approve each update.</div>
    ${libs.map(one).join('')}`;
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
