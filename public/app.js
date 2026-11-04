// The Referral Rush — client. The browser only renders what the server sends
// for this viewer and submits requested actions; every rule lives on the server.

// ---------- tiny safe templating ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
const fmt = (v) => (v == null || v === false ? '' : Array.isArray(v) ? v.map(fmt).join('') : v instanceof Raw ? v.s : esc(v));
const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? fmt(vals[i]) : ''), ''));

// ---------- state ----------
const $main = document.getElementById('main');
const $topRight = document.getElementById('topbar-right');
const $toast = document.getElementById('toast');
const S = {
  route: parseRoute(location.pathname),
  tab: location.pathname === '/rules' ? 'rules' : 'home',
  data: null,
  loadError: null,
  busy: false,
  ui: {
    open: new Set(),
    code: '', name: '', claim: '', formError: '',
    refEmployee: '', confirmRef: false,
    confirmAccept: '', confirmHire: '', refTargets: [],
    confirmAdvance: null, confirmReset: false,
    rejoin: {},
    arrivals: new Set(),
  },
};
let es = null;
let lastHtml = '';
let lastViewKey = '';
let lastPhase = null;
let toastTimer = null;
let pollTimer = null;
let seenNames = new Set();
let seenNamesKey = '';

function parseRoute(path) {
  const m = /^\/(join|room|host)\/([A-Za-z]{4})\/?$/.exec(path);
  if (!m) return { page: 'landing' };
  return { page: m[1] === 'host' ? 'host' : 'room', code: m[2].toUpperCase() };
}

function go(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  S.route = parseRoute(path);
  S.tab = 'home';
  S.data = null;
  S.loadError = null;
  lastHtml = '';
  start();
}
window.addEventListener('popstate', () => { S.route = parseRoute(location.pathname); S.data = null; start(); });

const storage = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function requestId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b); // works on plain-http classroom networks, unlike randomUUID
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- server calls ----------
class ApiError extends Error {
  constructor(status, body) { super(body?.error || 'Something went wrong.'); this.status = status; this.body = body || {}; }
}
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', 'X-RR': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Retry once on a network failure with the same request id: the server
// replays the stored result instead of doing the action twice.
async function postAction(path, body) {
  try { return await api(path, { method: 'POST', body }); }
  catch (e) {
    if (e instanceof ApiError) throw e;
    await new Promise((r) => setTimeout(r, 600));
    return api(path, { method: 'POST', body });
  }
}

async function load() {
  const { page, code } = S.route;
  if (page === 'landing') { render(); return; }
  try {
    S.data = await api(`/api/rooms/${code}/${page === 'host' ? 'host/state' : 'state'}`);
    S.loadError = null;
    if (S.data.viewer !== 'none') {
      connectEvents(code);
      storage.set('rr_last', { code, as: page === 'host' ? 'host' : 'player' });
    }
    if (page === 'room' && location.pathname.startsWith('/join/') && S.data.viewer !== 'none') {
      history.replaceState({}, '', `/room/${code}`);
    }
    // Lobby badges slide in only for people who arrive while this screen is open.
    const names = S.data.lobby?.names || [];
    const namesKey = `${code}|${S.data.round}`;
    if (seenNamesKey !== namesKey) { seenNamesKey = namesKey; seenNames = new Set(names); S.ui.arrivals = new Set(); }
    else { S.ui.arrivals = new Set(names.filter((n) => !seenNames.has(n))); names.forEach((n) => seenNames.add(n)); }
    // Memo and confetti only for a live phase change, never on first load or refresh.
    if (lastPhase && lastPhase !== S.data.phase) {
      announce(`Phase changed: ${S.data.phaseName}`);
      showMemo(S.data.phase, code);
      if (S.data.phase === 'results') confetti();
      S.ui.confirmAdvance = null; S.ui.confirmRef = false; S.ui.confirmHire = '';
    }
    lastPhase = S.data.phase;
  } catch (e) {
    if (page === 'host' && e.status === 403) {
      const key = new URLSearchParams(location.hash.slice(1)).get('key');
      if (key) {
        try {
          await api(`/api/rooms/${code}/host/claim`, { method: 'POST', body: { key } });
          history.replaceState({}, '', `/host/${code}`);
          return load();
        } catch (err) { S.loadError = { kind: 'host', message: err.message }; }
      } else {
        S.loadError = { kind: 'host', message: 'This device is not the host for this room.' };
      }
    } else if (e.status === 404) {
      S.loadError = { kind: 'missing', message: `There is no game with room code ${code}.` };
    } else if (!(e instanceof ApiError)) {
      S.loadError = S.data ? null : { kind: 'network', message: 'Cannot reach the game server. Check your connection.' };
    } else {
      S.loadError = { kind: 'other', message: e.message };
    }
  }
  render();
}

let loadQueued = false;
function scheduleLoad() {
  if (loadQueued) return;
  loadQueued = true;
  setTimeout(() => { loadQueued = false; load(); }, 120);
}

function connectEvents(code) {
  if (es && es.code === code) return;
  if (es) es.close();
  es = new EventSource(`/api/rooms/${code}/events`);
  es.code = code;
  es.onmessage = (ev) => { if (!S.data || String(S.data.version) !== ev.data) scheduleLoad(); };
}

function start() {
  if (es) { es.close(); es = null; }
  lastPhase = null;
  clearInterval(pollTimer);
  render();
  load();
  // Safety net in case a live connection silently drops (phones sleeping, flaky Wi-Fi).
  pollTimer = setInterval(() => { if (S.route.page !== 'landing' && document.visibilityState === 'visible') load(); }, 15000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.route.page !== 'landing') load(); });

// ---------- actions ----------
async function playerAct(type, payload = {}, { quiet = false } = {}) {
  if (S.busy) return;
  S.busy = true; render();
  try {
    const r = await postAction(`/api/rooms/${S.route.code}/action`, { type, requestId: requestId(), ...payload });
    // A "quiet" action shows its own paper animation, so screen readers get the text without a duplicate toast.
    if (r.message) (quiet ? announce : toast)(r.message);
    return r;
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.busy = false;
    await load();
  }
}

async function hostAct(type, payload = {}) {
  if (S.busy) return;
  S.busy = true; render();
  try {
    const r = await postAction(`/api/rooms/${S.route.code}/host/action`, { type, requestId: requestId(), ...payload });
    if (r.message) toast(r.message);
    return r;
  } catch (e) {
    if (e.body?.code === 'needs_confirm' && e.body.warnings) {
      S.ui.confirmAdvance = { from: payload.from, warnings: e.body.warnings };
    } else {
      toast(e.message, true);
    }
  } finally {
    S.busy = false;
    await load();
  }
}

function toast(message, error = false) {
  $toast.textContent = message;
  $toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = 'toast'; }, error ? 5000 : 3000);
}
// Phase changes are shown as a memo; screen readers hear them through a hidden live region.
function announce(message) {
  const el = document.getElementById('announcer');
  el.textContent = '';
  setTimeout(() => { el.textContent = message; }, 50);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast('Copied.');
}


// One confirmed slip can go to several employers: each is its own idempotent request.
async function sendReferrals() {
  if (S.busy) return;
  const pick = S.data.employer?.group.find((g) => g.label === S.ui.refEmployee);
  const targets = [...S.ui.refTargets];
  if (!pick || !targets.length) return;
  S.busy = true; render();
  const ok = []; const failed = [];
  for (const to of targets) {
    try {
      const r = await postAction(`/api/rooms/${S.route.code}/action`, { type: 'referral', requestId: requestId(), candidate: pick.label, to });
      if (r.ok) ok.push(to);
    } catch (e) { failed.push(`${to}: ${e.message}`); }
  }
  S.busy = false; S.ui.confirmRef = false; S.ui.refTargets = [];
  if (ok.length) {
    const msg = `Referral of ${pick.label} sent to ${ok.length === 1 ? `Employer ${ok[0]}` : `Employers ${ok.join(', ')}`}.`;
    if (reducedMotion()) toast(msg); else { announce(msg); showFlash('referred', { from: S.data.me.label, to: ok.length === 1 ? `Employer ${ok[0]}` : `Employers ${ok.join(', ')}`, label: pick.label, name: pick.name }); }
  }
  if (failed.length) toast(`Not sent: ${failed.join('; ')}`, true);
  await load();
}

// ---------- motion: memo, stamp flashes, confetti (presentation only) ----------
const $fx = document.getElementById('fx');
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MEMOS = {
  lobby: 'New round. Everyone back to the lobby.',
  reveal: 'Your assignments are ready. Tap your badge.',
  networking: 'Networking is open. Talk, trade and refer.',
  hiring: 'Hiring is open. Offers can now be made and answered.',
  results: 'The hiring results are in.',
  discussion: 'Debrief time. Gather round.',
};
function dismiss(el, after) {
  const t = setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, after);
  el.addEventListener('click', () => { clearTimeout(t); el.remove(); }, { once: true });
}
// Shown only when a live update moves the phase on, never on first load or refresh.
function showMemo(phase, code) {
  for (const old of $fx.querySelectorAll('.memo')) old.remove();
  const el = document.createElement('div');
  el.className = 'memo';
  el.innerHTML = String(html`<p class="memo-meta">Memo to all staff, room ${code}</p><strong>${MEMOS[phase] || 'The agenda has moved on.'}</strong>`);
  $fx.appendChild(el);
  dismiss(el, 2200);
}
// Shown only after the server confirmed the action.
function showFlash(kind, data) {
  if (reducedMotion()) return; // the plain toast already confirmed it
  for (const old of $fx.querySelectorAll('.flash')) old.remove();
  const el = document.createElement('div');
  el.className = 'flash';
  el.innerHTML = String(kind === 'referred'
    ? html`<div class="slip"><p class="slip-head">Recommendation, Employer ${data.from}</p>
        <p class="slip-body"><strong>${data.label}, ${data.name}</strong> sent to ${data.to}</p>
        <div class="stamp-spot"><span class="stamp thunk">REFERRED</span></div></div>`
    : html`<div class="letter"><div class="letterhead"><span class="seal">${data.employer}</span><span><strong>Employer ${data.employer}</strong><span>Hiring confirmed</span></span></div>
        <p><strong>${data.label}, ${data.name}</strong> is joining your team.</p><div class="stamp-spot"><span class="stamp thunk">HIRED</span></div></div>`);
  $fx.appendChild(el);
  dismiss(el, 1900);
}
function confetti() {
  if (reducedMotion()) return;
  const colours = ['var(--orange)', 'var(--mustard)', 'var(--sage)', 'var(--sheet)', 'var(--forest)'];
  for (let i = 0; i < 42; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = `${Math.random() * 100}%`;
    c.style.background = colours[i % colours.length];
    c.style.setProperty('--dx', `${(Math.random() - 0.5) * 220}px`);
    c.style.setProperty('--rot', `${(Math.random() - 0.5) * 900}deg`);
    c.style.animationDelay = `${Math.random() * 250}ms`;
    $fx.appendChild(c);
    setTimeout(() => c.remove(), 1800);
  }
}

// ---------- shared bits ----------
const DISCUSSION = [
  'Did you recommend strong candidates or protect your advantage?',
  'Did anyone offer help mainly to get something back?',
  'How did it feel to depend on someone who had little incentive to help?',
  'What would change if the goal were helping everyone find work?',
];
const phaseOrder = ['lobby', 'reveal', 'networking', 'hiring', 'results', 'discussion'];
const PHASE_SHORT = ['Lobby', 'Roles', 'Network', 'Hiring', 'Results', 'Debrief'];
const atLeast = (phase) => S.data && phaseOrder.indexOf(S.data.phase) >= phaseOrder.indexOf(phase);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const disabled = (cond) => (cond ? new Raw('disabled') : '');
const employerName = (label) => S.data?.employers?.find((e) => e.label === label)?.name || '';
const seenKey = () => `rr_seen_${S.data.code}_${S.data.round}`;

function fold(key, title, meta, body, defaultOpen = false) {
  const open = S.ui.open.has(key) || (defaultOpen && !S.ui.open.has(`!${key}`));
  return html`<details class="fold" data-fold="${key}" ${open ? new Raw('open') : ''}>
    <summary>${title}${meta != null ? html`<span class="summary-meta">${meta}</span>` : ''}</summary>
    <div class="fold-body">${body}</div>
  </details>`;
}
const MUG = new Raw(`<svg viewBox="0 0 60 80" aria-hidden="true"><g class="steam" fill="none" stroke="#25382F" stroke-width="2.5" stroke-linecap="round"><path d="M22 30c-4-6 4-10 0-16"/><path d="M34 30c-4-6 4-10 0-16"/></g><g stroke="#25382F" stroke-width="3" stroke-linejoin="round"><path d="M10 36h36v32a8 8 0 0 1-8 8H18a8 8 0 0 1-8-8z" fill="#FBF6EA"/><path d="M46 44h4a8 8 0 0 1 0 16h-4" fill="none"/><path d="M10 48h36v10H10z" fill="#E16C3A"/></g></svg>`);
const wait = (text) => html`<div class="wait">${MUG}<span>${text}</span></div>`;
const grade = (score) => (score == null
  ? html`<span class="grade-unknown">Score unknown</span>`
  : html`<span class="grade" aria-label="Score ${score} out of 10">${score}<small>/10</small></span>`);
const idchip = (label) => html`<span class="idchip">${label}</span>`;
const sign = (code, big = false) => html`<div class="sign${big ? ' big' : ''}"><small>Meeting room</small><span class="code" aria-label="Room code ${code.split('').join(' ')}">${code}</span></div>`;
const sceneStrip = () => new Raw(`<svg viewBox="0 0 400 88" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
  <use href="#sym-window" x="10" y="2" width="92" height="83"/>
  <use href="#sym-plant" x="176" y="20" width="46" height="69"/>
  <use href="#sym-board" x="262" y="2" width="124" height="86"/>
  <rect x="0" y="82" width="400" height="6" fill="#E6B85A"/></svg>`);

function summarySheet() {
  const r = S.data.results;
  if (!r) return '';
  const max = Math.max(1, ...r.totals.map((t) => t.total));
  const tie = r.winners.length > 1;
  const best = r.totals[0]?.total ?? 0;
  const line = tie
    ? `Employers ${r.winners.join(', ').replace(/, ([^,]*)$/, ' and $1')} tie with ${plural(best, 'point')} each.`
    : `Employer ${r.winners[0]} wins with ${plural(best, 'point')}.`;
  return html`<section class="summary" aria-labelledby="sum-title">
    <div class="summary-head"><h2 id="sum-title">Hiring summary</h2><span class="count">Room ${S.data.code}</span></div>
    <p class="winner-line">${line}</p>
    <ul class="tally">${r.totals.map((t) => {
      const won = r.winners.includes(t.employer);
      return html`<li>${idchip(t.employer)}
        <span class="stack tight"><span class="who">${t.name}, ${t.filled} of ${r.hires} hired</span>
          <span class="bar" aria-hidden="true"><i data-pct="${Math.round((t.total / max) * 100)}"></i></span>
          ${won ? html`<span><span class="stamp">${tie ? 'SHARED WIN' : 'TOP RECRUITER'}</span></span>` : ''}</span>
        <span class="total" aria-label="${t.total} points">${t.total}</span></li>`;
    })}</ul>
  </section>`;
}

function discussionBlock() {
  return html`<section class="stack">
    <div class="section-title"><h2>Debrief</h2><span class="count">4 questions</span></div>
    <ol class="q-list">${DISCUSSION.map((q) => html`<li class="instruction">${q}</li>`)}</ol>
  </section>`;
}

function rosterFold() {
  const d = S.data;
  if (!d.employers) return '';
  return fold('roster', 'Staff directory', plural(d.employers.length, 'employer'), html`
    <ul class="files">${d.employers.map((e) => html`<li>${idchip(e.label)}<span class="grow name">${e.name}</span>${d.me?.label === e.label ? html`<span class="tag tag-accent">You</span>` : ''}</li>`)}</ul>`);
}

function setupBox(setup) {
  if (!setup.ready) {
    return html`<div class="notice notice-accent">${setup.players} signed in. ${plural(setup.needed, 'more player')} needed to start (minimum ${S.data.minPlayers}; ${S.data.recommendedPlayers} or more is best).</div>`;
  }
  return html`<div class="limit-box">
    <div><strong>${setup.players}</strong>${setup.players === 1 ? 'employer' : 'employers'}</div>
    <div><strong>${setup.bank}</strong>candidates in the bank</div>
    <div><strong>${setup.groupSize}</strong>in each private file</div>
    <div><strong>${setup.hires}</strong>hires each</div>
  </div>`;
}

function badgeList(names, mine) {
  const arrivals = S.ui.arrivals || new Set();
  return html`<ul class="badges">${names.map((n) => html`<li class="mini-badge${n === mine ? ' me' : ''}${arrivals.has(n) ? ' arrive' : ''}">
    <span class="who">${n}</span><span class="role">${n === mine ? 'You' : 'Visitor'}</span></li>`)}</ul>`;
}

// ---------- landing & join ----------
function landingView() {
  const last = storage.get('rr_last');
  return html`<div class="scene-strip">${sceneStrip()}</div>
  <div class="landing">
    <section class="title-block">
      <h1 class="title"><span class="line">Referral</span><span class="stamped">Rush</span></h1>
      <p class="tagline">Great connections. Questionable motives.</p>
      <p class="muted desc">A party game for one room and everyone's phones. Everyone is hiring, everyone has inside information, and there aren't enough great candidates to go round. Who will you vouch for?</p>
    </section>
    <div class="clipboard">
      <div class="clipboard-sheet">
        <form class="stack" data-form="join-landing" novalidate>
          <div class="form-head"><h2>Join a game</h2><span class="form-id">Form RR-1</span></div>
          <div class="field">
            <label for="code">Room code</label>
            <input class="input input-code" id="code" name="code" data-bind="code" data-key="code" value="${S.ui.code}"
              maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
          </div>
          <div class="field">
            <label for="name">Your name</label>
            <input class="input" id="name" name="name" data-bind="name" data-key="name" value="${S.ui.name}" maxlength="20" autocomplete="nickname" required>
          </div>
          ${S.ui.formError ? html`<p class="form-error" role="alert">${S.ui.formError}</p>` : ''}
          <button class="btn btn-primary" type="submit" data-key="join" ${disabled(S.busy)}>${S.busy ? 'Joining…' : 'Join game'}</button>
          ${last?.code ? html`<button class="btn btn-secondary btn-small" type="button" data-act="resume" data-key="resume">Return to room ${last.code}</button>` : ''}
        </form>
        <div class="host-line">
          <p class="small muted">Running the session? The host uses their own screen and does not play.</p>
          <button class="btn btn-secondary" data-act="create-room" data-key="create" ${disabled(S.busy)}>Host a new game</button>
        </div>
      </div>
    </div>
  </div>`;
}

function joinView() {
  const d = S.data;
  const started = d.phase !== 'lobby';
  return html`<div class="stack-lg">
    <div class="stack">${sign(d.code)}<h1>Sign in to join</h1></div>
    ${started ? html`<div class="notice notice-warn">This game has already started. You can sign in as an observer and follow public updates. The host can add you as a player after a reset.</div>` : ''}
    <div class="clipboard"><div class="clipboard-sheet">
      <form class="stack" data-form="join-room" novalidate>
        <div class="form-head"><h2>Visitor sign-in</h2><span class="form-id">Room ${d.code}</span></div>
        <div class="field">
          <label for="name">Your name</label>
          <input class="input" id="name" name="name" data-bind="name" data-key="name" value="${S.ui.name}" maxlength="20" autocomplete="nickname" required>
        </div>
        ${S.ui.formError ? html`<p class="form-error" role="alert">${S.ui.formError}</p>` : ''}
        <button class="btn btn-primary" type="submit" data-key="join" ${disabled(S.busy)}>${started ? 'Join as observer' : 'Join game'}</button>
      </form>
    </div></div>
    <div class="folds">${fold('claim', 'Already joined on another phone?', null, html`<form class="stack" data-form="reclaim" novalidate>
      <p class="muted">Ask the host for a rejoin code, then enter it here to get your role back.</p>
      <div class="field">
        <label for="claim">Rejoin code</label>
        <input class="input input-code" id="claim" data-bind="claim" data-key="claim" value="${S.ui.claim}" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false">
      </div>
      <button class="btn btn-secondary" type="submit" data-key="reclaim" ${disabled(S.busy)}>Rejoin</button>
    </form>`)}</div>
  </div>`;
}

// ---------- player (every player is an employer) ----------
function phaseInstruction() {
  return {
    lobby: 'Waiting for the host to assign roles.',
    reveal: 'Tap your badge, then study your private file.',
    networking: 'Trade referrals and negotiate in person.',
    hiring: 'Hire the best candidates before someone else does.',
    results: 'The hiring results are in.',
    discussion: 'Debrief together.',
  }[S.data.phase];
}

function idCard(me, objective) {
  const seen = storage.get(seenKey()) === true;
  if (S.data.phase === 'reveal') {
    return html`<div class="badge-wrap">
      <button class="badge" data-act="flip" data-key="badge" aria-pressed="${seen ? 'true' : 'false'}"
        aria-label="${seen ? `Your role: Employer ${me.label}. ${objective}` : 'Tap to reveal your role'}">
        <span class="badge-inner">
          <span class="badge-face badge-back" aria-hidden="${seen ? 'true' : 'false'}">
            <span class="seal">Referral Rush Inc.</span>
            <span class="hint">Tap to reveal your role</span>
            <span class="small">Keep your screen to yourself</span>
          </span>
          <span class="badge-face badge-front" aria-hidden="${seen ? 'false' : 'true'}">
            <span class="band">Referral Rush Inc. staff ID</span>
            <span class="body">
              <span class="badge-role">Employer</span>
              <span class="badge-label">${me.label}</span>
              <span class="badge-name">${me.name}</span>
            </span>
            <span class="badge-foot">${objective}</span>
          </span>
        </span>
      </button>
    </div>`;
  }
  return html`<div class="id-strip">
    <span class="id-glyph" aria-hidden="true">${me.label}</span>
    <span class="id-text"><strong>Employer ${me.label}</strong><span class="muted">${me.name}. ${objective}</span></span>
  </div>`;
}

function employerHome() {
  const d = S.data; const me = d.me; const x = d.employer; const H = x.hires;
  const parts = [idCard(me, 'Goal: hire the highest total score.')];
  if (d.phase === 'reveal' && storage.get(seenKey()) !== true) { parts.push(wait('Tap the badge to see your role.')); return parts; }

  const groupFile = html`<div class="folder"><span class="folder-tab">Private file: Employer ${me.label}</span>
    <div class="folder-body">
      <p class="folder-note">You know these scores. You cannot hire these candidates.</p>
      <ul class="files">${x.group.map((g) => html`<li>${idchip(g.label)}<span class="grow"><span class="name">${g.name}</span>${g.taken ? html`<span class="tag-row"><span class="tag">Hired by a rival</span></span>` : ''}</span>${grade(g.score)}</li>`)}</ul>
    </div></div>`;
  const receivedSlips = x.referralsReceived.length
    ? html`<div class="slips">${x.referralsReceived.map((r) => html`<div class="slip"><p class="slip-head">Recommendation from Employer ${r.from}</p>
        <div class="row"><span class="grow slip-body">${idchip(r.label)} <strong>${r.name}</strong></span>${grade(r.score)}</div></div>`)}</div>`
    : html`<p class="muted">No recommendations received yet.</p>`;
  const sentSlips = x.referralsSent.length
    ? html`<div class="slips">${x.referralsSent.map((r) => html`<div class="slip stamped"><p class="slip-head">Sent to Employer ${r.to}</p>
        <p class="slip-body"><strong>${r.label}, ${r.name}</strong>. Score ${r.score}.</p><span class="stamp">REFERRED</span></div>`)}</div>`
    : html`<p class="muted">You have not sent any referrals yet.</p>`;

  if (d.phase === 'reveal') {
    parts.push(html`<section class="stack"><h2>Your job</h2>
      <p class="instruction">Finish with the highest combined score from your ${plural(H, 'hire')}.</p>
      <p>Your private file shows the true scores of ${plural(x.group.length, 'candidate')}, but you cannot hire them. To learn about anyone else, trade referrals with the other employers.</p></section>`);
    parts.push(groupFile);
    parts.push(wait('Waiting for the host to open networking.'));
  }

  if (d.phase === 'networking') {
    const rivals = d.employers.filter((e) => e.label !== me.label);
    const pick = x.group.find((g) => g.label === S.ui.refEmployee);
    const already = new Set(x.referralsSent.filter((r) => r.label === S.ui.refEmployee).map((r) => r.to));
    const targets = S.ui.refTargets.filter((t) => rivals.some((r) => r.label === t) && !already.has(t));
    const form = S.ui.confirmRef && pick && targets.length
      ? html`<div class="slip stack" role="alertdialog" aria-labelledby="ref-confirm-title">
          <p class="slip-head" id="ref-confirm-title">Check the slip before you send it</p>
          <p class="slip-body">Employer ${me.label} recommends <strong>${pick.label}, ${pick.name}</strong> to ${targets.length === 1 ? `Employer ${targets[0]}` : `Employers ${targets.join(', ')}`}. Candidate score: <strong>${pick.score}</strong>.</p>
          <p class="small muted">Referrals cannot be edited or withdrawn.</p>
          <div class="btn-row">
            <button class="btn btn-secondary" data-act="ref-cancel" data-key="ref-cancel">Back</button>
            <button class="btn btn-primary" data-act="ref-send" data-key="ref-send" ${disabled(S.busy)}>${S.busy ? 'Sending…' : targets.length === 1 ? 'Send referral' : `Send ${targets.length} referrals`}</button>
          </div>
        </div>`
      : html`<form class="stack" data-form="referral" novalidate>
          <fieldset class="choices">
            <legend>1. Who are you recommending?</legend>
            ${x.group.map((g) => html`<label class="choice"><input type="radio" name="refEmployee" value="${g.label}" data-bind="refEmployee" ${g.label === S.ui.refEmployee ? new Raw('checked') : ''}>
              <span>${idchip(g.label)}<span class="grow">${g.name}</span>${grade(g.score)}</span></label>`)}
          </fieldset>
          <fieldset class="choices" ${pick ? '' : new Raw('disabled')}>
            <legend>2. Send it to</legend>
            ${pick ? html`<button type="button" class="linkish" data-act="ref-all" data-key="ref-all">Select every employer who has not had it yet</button>` : html`<p class="small muted">Choose a candidate first.</p>`}
            <div class="seg">${rivals.map((e) => {
              const sent = already.has(e.label);
              return html`<label class="choice"><input type="checkbox" value="${e.label}" data-bind="refTargets" ${targets.includes(e.label) ? new Raw('checked') : ''} ${sent || !pick ? new Raw('disabled') : ''}>
                <span><span class="grow">Employer ${e.label}<br><span class="small muted">${sent ? 'Already sent' : e.name}</span></span></span></label>`;
            })}</div>
          </fieldset>
          <button class="btn btn-primary" type="submit" data-key="ref-review" ${disabled(!pick || !targets.length)}>${targets.length > 1 ? `Review ${targets.length} referrals` : 'Review referral'}</button>
        </form>`;
    parts.push(html`<section class="stack">
      <div class="section-title"><h2>Write referrals</h2><span class="count">${x.referralsSent.length} sent</span></div>
      <p class="muted">Send as many as you like, to anyone. Every slip carries the candidate's true score.</p>
      ${form}
    </section>`);
    parts.push(html`<section class="stack"><div class="section-title"><h2>Recommendations received</h2><span class="count">${x.referralsReceived.length}</span></div>${receivedSlips}</section>`);
    parts.push(html`<div class="folds">${fold('sent', 'Referrals you sent', `${x.referralsSent.length}`, sentSlips)}</div>`);
    parts.push(groupFile);
  }

  if (d.phase === 'hiring') {
    const slots = [];
    x.hired.forEach((h) => slots.push(html`<div class="slot filled"><span class="slot-label">Filled</span>
      <span class="slot-state">${h.label}, ${h.name}</span>
      <span class="small">${h.score == null ? 'Score: awaiting reveal' : `Score ${h.score}`}</span></div>`));
    for (let i = x.hired.length; i < H; i++) slots.push(html`<div class="slot"><span class="slot-label">Open position</span><span class="slot-state">Hire from the list below</span></div>`);
    const full = x.hired.length >= H;
    parts.push(html`<section class="stack">
      <div class="section-title"><h2>Your positions</h2><span class="count">${x.hired.length} of ${H} filled</span></div>
      <div class="slots">${slots}</div>
      ${full ? html`<div class="notice notice-ok">All positions filled. Your score is revealed with the results.</div>` : ''}
    </section>`);
    const rank = (c) => (c.taken ? 2 : c.knownScore == null ? 1 : 0);
    const list = x.candidates.filter((c) => !c.takenByMe)
      .sort((a, b) => rank(a) - rank(b) || (b.knownScore ?? 0) - (a.knownScore ?? 0) || a.label.localeCompare(b.label, 'en', { numeric: true }));
    const open = list.filter((c) => !c.taken).length;
    parts.push(html`<section class="stack">
      <div class="section-title"><h2>Candidate bank</h2><span class="count">${open} available</span></div>
      <p class="small muted">Candidates you were recommended come first. Your own file is not listed. Without a referral, a score is a guess.</p>
      <ul class="ledger">${list.map((c) => {
        const tags = [];
        if (c.referredBy) tags.push(html`<span class="tag tag-accent">Referred by ${c.referredBy}</span>`);
        if (c.taken) tags.push(html`<span class="tag">Hired by a rival</span>`);
        if (S.ui.confirmHire === c.label && !c.taken && !full) {
          return html`<li class="confirm-row" role="alertdialog" aria-labelledby="hire-${c.label}">
            <p id="hire-${c.label}"><strong>Hire ${c.label}, ${c.name}?</strong> ${c.knownScore == null ? 'Score unknown.' : `Score ${c.knownScore}.`} Hiring is final.</p>
            <div class="btn-row">
              <button class="btn btn-secondary btn-small" data-act="hire-cancel" data-key="hire-cancel">Back</button>
              <button class="btn btn-primary btn-small" data-act="hire" data-candidate="${c.label}" data-key="hire-yes-${c.label}" ${disabled(S.busy)}>${S.busy ? 'Hiring…' : 'Hire'}</button>
            </div></li>`;
        }
        return html`<li>${idchip(c.label)}<span class="grow"><span class="name">${c.name}</span>${tags.length ? html`<span class="tag-row">${tags}</span>` : ''}</span>
          ${c.taken ? '' : html`<span class="stack tight end">${grade(c.knownScore)}
          <button class="btn btn-primary btn-small" data-act="hire-ask" data-candidate="${c.label}" data-key="hire-${c.label}" ${disabled(full || S.busy)}>Hire</button></span>`}</li>`;
      })}</ul>
    </section>`);
    parts.push(html`<div class="folds">
      ${fold('received', 'Recommendations received', `${x.referralsReceived.length}`, receivedSlips)}
      ${fold('group', 'Private file: you cannot hire these', plural(x.group.length, 'candidate'), groupFile)}
    </div>`);
  }

  if (atLeast('results')) {
    parts.push(html`<section class="stack" aria-label="Your result">
      <div class="section-title"><h2>Your total</h2><span class="big-score">${x.myTotal}</span></div>
      ${x.hired.length ? html`<ul class="files">${x.hired.map((h) => html`<li>${idchip(h.label)}<span class="grow name">${h.name}</span>${grade(h.score)}</li>`)}</ul>` : html`<p class="muted">You did not hire anyone. Empty positions score zero.</p>`}
    </section>`);
    parts.push(summarySheet());
    if (d.phase === 'discussion') parts.push(discussionBlock());
    parts.push(html`<div class="folds">${fold('sent', 'Referrals you sent', `${x.referralsSent.length}`, sentSlips)}${fold('received', 'Recommendations received', `${x.referralsReceived.length}`, receivedSlips)}</div>`);
  }
  return parts;
}

function spectatorHome() {
  const d = S.data;
  const parts = [html`<section class="stack">${sign(d.code)}<h1>You're observing</h1>
    <p class="muted">You signed in after roles were assigned, so you see public updates only. The host can add you as a player after a reset.</p></section>`];
  if (d.results) parts.push(summarySheet());
  else parts.push(wait(`${d.phaseName} is under way. Waiting for the host.`));
  if (d.phase === 'discussion') parts.push(discussionBlock());
  parts.push(html`<div class="folds">${rosterFold()}</div>`);
  return parts;
}

function playerView() {
  const d = S.data;
  if (d.viewer === 'none') return joinView();
  let body;
  if (d.viewer === 'spectator') body = spectatorHome();
  else if (!d.me.role) {
    body = [html`<section class="stack">${sign(d.code)}<h1>You're on the list, ${d.me.name}</h1>
        ${wait('Waiting for the host to hand out roles. Grab a coffee.')}</section>`,
      html`<section class="stack"><div class="section-title"><h2>Sign-in sheet</h2><span class="count">${d.setup.players} present</span></div>
        ${badgeList(d.lobby.names, d.me.name)}</section>`,
      html`<section class="stack">${setupBox(d.setup)}</section>`];
  } else body = employerHome();
  const head = d.me?.role ? html`<p class="instruction">${phaseInstruction()}</p>` : '';
  const roster = d.me?.role && d.phase !== 'reveal' ? html`<div class="folds">${rosterFold()}</div>` : '';
  return html`<div class="stack-lg">${head}${body}${roster}</div>`;
}

// ---------- host: meeting control board ----------
function hostView() {
  const d = S.data; const h = d.host;
  const idx = phaseOrder.indexOf(d.phase);
  const side = html`<aside class="host-side" aria-label="Room details">
    ${sign(d.code, true)}
    <div class="pinned">
      <p class="small muted">Scan to join</p>
      <img class="qr" src="/api/rooms/${d.code}/qr.svg?v=${d.round}" alt="QR code to join room ${d.code}">
      <p class="join-url">${h.joinUrl.replace(/^https?:\/\//, '')}</p>
      <button class="btn btn-secondary btn-small" data-act="copy" data-text="${h.joinUrl}" data-key="copy-join">Copy join link</button>
    </div>
    ${/\/\/(localhost|127\.0\.0\.1)/.test(h.joinUrl) ? html`<div class="notice notice-warn">Phones cannot open "localhost". Open this page from the computer's network address.</div>` : ''}
    <div class="folds">${fold('hostlink', 'Run the game from another device', null, html`<div class="stack">
      <p class="small muted">Anyone with this private link can control the game. Keep it off the projector.</p>
      <button class="btn btn-secondary btn-small" data-act="copy" data-text="${h.hostUrl}" data-key="copy-host">Copy private host link</button>
    </div>`)}</div>
  </aside>`;

  const nextLabel = h.nextAction;
  const players = h.members.filter((m) => !m.spectator);
  const spectators = h.members.filter((m) => m.spectator);
  const phaseBody = [];
  const afterPrimary = [];
  let canAdvance = !!nextLabel;
  let blockReason = '';

  if (d.phase === 'lobby') {
    canAdvance = d.setup.ready;
    if (!d.setup.ready) blockReason = `Waiting for ${plural(d.setup.needed, 'more player')}.`;
    phaseBody.push(html`<section class="stack">
      <div class="section-title"><h2>Attendance</h2><span class="count">${plural(players.length, 'player')}</span></div>
      ${setupBox(d.setup)}
    </section>`);
    afterPrimary.push(players.length
      ? html`<section class="stack"><div class="section-title"><h2>Sign-in sheet</h2><span class="count">${players.length}</span></div>
        <ul class="ledger">${players.map((m) => html`<li><span class="grow name">${m.name}</span>
        <button class="btn btn-secondary btn-small" data-act="remove" data-id="${m.id}" data-key="rm-${m.id}" aria-label="Remove ${m.name}" ${disabled(S.busy)}>Remove</button></li>`)}</ul></section>`
      : wait('Waiting for players to sign in.'));
  } else {
    phaseBody.push(html`<p class="muted">${plural(players.length, 'employer')} and ${plural(d.setup.bank, 'candidate')} in the bank. Each employer knows ${d.setup.groupSize} scores and hires ${d.setup.hires}.</p>`);
  }
  if (d.phase === 'reveal') phaseBody.push(wait('Players are reading their badges. Open networking when the room is ready.'));

  const progressList = (mode) => html`<ul class="ledger">${h.progress.map((p) => html`<li>${idchip(p.employer)}
    <span class="grow"><span class="name">${p.name}</span>
      ${mode === 'hiring' ? html`<span class="bar" aria-hidden="true"><i data-pct="${Math.round((p.filled / d.setup.hires) * 100)}"></i></span>` : ''}</span>
    <span class="count">${mode === 'hiring' ? `${p.filled} of ${d.setup.hires} hired` : `${p.referralsSent} sent, ${p.referralsReceived} received`}</span></li>`)}</ul>`;
  if (d.phase === 'networking') {
    const total = h.referrals.length;
    phaseBody.push(html`<section class="stack"><div class="section-title"><h2>Referrals</h2><span class="count">${plural(total, 'slip')} so far</span></div>
      <p class="small muted">Referrals are optional and unlimited. Open hiring whenever the room is ready.</p>${progressList('networking')}</section>`);
  }
  if (d.phase === 'hiring') {
    const filled = h.progress.reduce((s, p) => s + p.filled, 0);
    phaseBody.push(html`<section class="stack"><div class="section-title"><h2>Positions filled</h2><span class="count">${filled} of ${h.progress.length * d.setup.hires}</span></div>${progressList('hiring')}</section>`);
  }
  if (atLeast('results')) {
    phaseBody.push(summarySheet());
    if (d.phase === 'discussion') phaseBody.push(discussionBlock());
  }

  let primary = '';
  // Live warnings, so the panel updates if employers finish while the host is deciding.
  const confirm = S.ui.confirmAdvance && S.ui.confirmAdvance.from === d.phase ? { ...S.ui.confirmAdvance, warnings: h.warnings } : null;
  if (nextLabel) {
    primary = confirm
      ? html`<div class="slip stack" role="alertdialog" aria-labelledby="adv-title">
          <h3 id="adv-title">${confirm.warnings.length ? 'Some positions are still open' : `${nextLabel}?`}</h3>
          ${confirm.warnings.length ? html`<ul class="bullets">${confirm.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
          ${d.phase === 'hiring' ? html`<p class="muted">Hiring will close and the results will be shown to everyone. This cannot be undone.</p>` : html`<p class="muted">You can stay in ${d.phaseName.toLowerCase()} or continue anyway.</p>`}
          <div class="btn-row">
            <button class="btn btn-secondary" data-act="advance-cancel" data-key="adv-cancel">Stay in ${d.phaseName.toLowerCase()}</button>
            <button class="btn btn-primary" data-act="advance-confirm" data-key="adv-confirm" ${disabled(S.busy)}>${d.phase === 'hiring' ? 'Reveal results' : 'Continue anyway'}</button>
          </div></div>`
      : html`<div class="stack tight">
          <button class="btn btn-primary" data-act="advance" data-key="advance" ${disabled(!canAdvance || S.busy)}>${nextLabel}</button>
          ${blockReason ? html`<p class="small muted">${blockReason}</p>` : h.warnings.length ? html`<p class="small muted">${h.warnings[0]}${h.warnings.length > 1 ? ` (+${h.warnings.length - 1} more)` : ''}</p>` : ''}
        </div>`;
  }

  const priv = d.phase === 'lobby' ? '' : fold('private', 'Private: files, scores and hires', 'Host only', html`<div class="stack">
    <p class="small muted">Keep this section off the projector.</p>
    ${h.progress.map((p) => {
      const file = h.bank.filter((c) => c.group === p.employer);
      const hires = h.bank.filter((c) => c.hiredBy === p.employer);
      const pts = hires.reduce((s, c) => s + c.score, 0);
      return html`<div class="folder"><span class="folder-tab">Employer ${p.employer}: ${p.name}, ${pts} pts</span><div class="folder-body">
        <p class="small"><strong>Hired:</strong> ${hires.length ? hires.map((c) => `${c.label} ${c.name} (${c.score})`).join(', ') : 'nobody yet'}</p>
        <ul class="files">${file.map((c) => html`<li>${idchip(c.label)}<span class="grow"><span class="name">${c.name}</span>${c.hiredBy ? html`<span class="tag-row"><span class="tag tag-ok">Hired by ${c.hiredBy}</span></span>` : ''}</span>${grade(c.score)}</li>`)}</ul></div></div>`;
    })}
    ${h.referrals.length ? html`<div class="stack tight"><h3>Referrals</h3><ul class="files">${h.referrals.map((r) => html`<li>${idchip(r.from)}<span class="grow">${r.label} ${r.name} to Employer ${r.to}</span>${grade(r.score)}</li>`)}</ul></div>` : ''}
  </div>`);

  const people = fold('people', 'Players and rejoin codes', plural(h.members.length, 'person', 'people'), html`<div class="stack">
    <p class="small muted">If someone switches phones or browsers, give them a rejoin code. It works once and expires in 15 minutes.</p>
    <ul class="ledger">${h.members.map((m) => html`<li><span class="grow"><span class="name">${m.name}</span>
      <span class="tag-row">${m.spectator ? html`<span class="tag">Observer</span>` : m.label ? html`<span class="tag">Employer ${m.label}</span>` : ''}
      ${S.ui.rejoin[m.id] ? html`<span class="tag tag-warn">Code: <span class="mono">${S.ui.rejoin[m.id]}</span></span>` : ''}</span></span>
      <span class="row tight">
      <button class="btn btn-secondary btn-small" data-act="rejoin" data-id="${m.id}" data-key="rj-${m.id}" ${disabled(S.busy)}>Rejoin code</button>
      ${m.spectator || d.phase === 'lobby' ? html`<button class="btn btn-secondary btn-small" data-act="remove" data-id="${m.id}" data-key="rmx-${m.id}" aria-label="Remove ${m.name}" ${disabled(S.busy)}>Remove</button>` : ''}
      </span></li>`)}</ul>
    ${spectators.length && d.phase !== 'lobby' ? html`<p class="small muted">${plural(spectators.length, 'observer')} will become players after a reset.</p>` : ''}
  </div>`);

  const resetPanel = fold('reset', d.phase === 'discussion' ? 'Play again' : 'Reset game', null, S.ui.confirmReset
    ? html`<div class="stack"><p><strong>Reset the game?</strong> Roles, the candidate bank, referrals, hires and results will be erased. Everyone goes back to the lobby, and observers become players.</p>
        <div class="btn-row"><button class="btn btn-secondary" data-act="reset-cancel" data-key="reset-cancel">Keep playing</button>
        <button class="btn btn-danger" data-act="reset-confirm" data-key="reset-confirm" ${disabled(S.busy)}>Reset everything</button></div></div>`
    : html`<div class="stack"><p class="muted">Start over with everyone currently in the room.</p>
        <button class="btn btn-danger" data-act="reset-ask" data-key="reset-ask">Reset game…</button></div>`, d.phase === 'discussion');

  return html`<div class="host-grid">${side}<section class="board" aria-label="Meeting controls">
    <div class="stack tight">
      <p class="small muted">Agenda, step ${idx + 1} of 6</p>
      <ol class="agenda">${phaseOrder.map((p, i) => html`<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}" ${i === idx ? new Raw('aria-current="step"') : ''}><span class="step" aria-hidden="true">${i < idx ? '✓' : i + 1}</span>${PHASE_SHORT[i]}</li>`)}</ol>
    </div>
    <h1>${d.phaseName}</h1>
    ${phaseBody}
    ${primary}
    ${afterPrimary}
    <div class="folds">${priv}${people}${resetPanel}</div>
  </section></div>`;
}

// ---------- rules: the office handbook ----------
function rulesView() {
  const s = S.data?.setup;
  const ready = !!s?.ready;
  return html`<div class="stack-lg handbook">
    <section class="stack">
      <p class="clause">Employee handbook, rev. Q4</p>
      <h1>Rules</h1>
      <p class="lede">Talk in person. Use your phone to read your private file, send referrals and hire.</p>
      ${ready ? html`<div class="limit-box"><div><strong>${s.hires}</strong>hires per employer</div><div><strong>${s.groupSize}</strong>candidates in your private file</div><div><strong>${s.bank}</strong>candidates in the bank</div></div>`
          : html`<p class="muted">The bank holds 4 candidates per player. Each employer privately knows 4 of them and hires 2.</p>`}
    </section>
    <section class="stack">
      <h2>Goal</h2>
      <ul>
        <li>Every player is an employer. Finish with the <strong>highest combined score</strong> from your hires. Nothing else counts.</li>
      </ul>
    </section>
    <section class="stack">
      <h2>Confidential information</h2>
      <ul>
        <li>The candidate bank is run by the computer. Every candidate has a secret score from 1 to 10.</li>
        <li>You hold the private file for a few candidates and know their true scores, but you <strong>cannot hire anyone in your own file</strong>.</li>
        <li>Everyone else's scores are hidden unless another employer refers them to you.</li>
      </ul>
    </section>
    <section class="stack">
      <h2>How the day goes</h2>
      <ol>
        <li><strong>Role reveal.</strong> Tap your badge and read your private file.</li>
        <li><strong>Networking.</strong> Send as many referrals as you like, to any other employer, about candidates in your file. Each referral shows the candidate's true score and cannot be changed or taken back. Referrals are optional.</li>
        <li><strong>Hiring.</strong> Tap Hire on any available candidate outside your file. First come, first served. Each employer fills ${ready ? plural(s.hires, 'position') : '2 positions'}, and a hire is final.</li>
        <li><strong>Results.</strong> Your score is the total of your hires' scores. Empty positions score zero. Highest total wins; ties share the win.</li>
        <li><strong>Debrief.</strong> Talk about what happened.</li>
      </ol>
    </section>
    <section class="stack">
      <h2>Good to know</h2>
      <ul>
        <li>Deals happen out loud. There is no chat in the app.</li>
        <li>A referral helps a rival as much as it helps you. Decide who you trust, and what you want in return.</li>
        <li>The host decides when each phase starts and ends. There is no timer.</li>
      </ul>
    </section>
    <button class="btn btn-primary" data-nav="home" data-key="rules-back">Back to ${S.route.page === 'landing' ? 'the start page' : 'the game'}</button>
  </div>`;
}

// ---------- render ----------
function errorView() {
  const e = S.loadError;
  return html`<div class="stack-lg">
    <h1>${e.kind === 'missing' ? 'No meeting in that room' : e.kind === 'host' ? 'Host access needed' : 'The office is unreachable'}</h1>
    <p class="instruction">${e.message}</p>
    ${e.kind === 'host' ? html`<p class="muted">Open the private host link from the device that created the game, or join as a player instead.</p>
      <a class="btn btn-secondary" href="/join/${S.route.code}" data-link>Join as a player</a>` : ''}
    ${e.kind === 'network' ? html`<button class="btn btn-primary" data-act="retry" data-key="retry">Try again</button>` : ''}
    <a class="btn btn-secondary" href="/" data-link>Go to the start page</a>
  </div>`;
}

function render() {
  const { page } = S.route;
  let out;
  if (S.tab === 'rules') out = rulesView();
  else if (page === 'landing') out = landingView();
  else if (S.loadError && !S.data) out = errorView();
  else if (!S.data) out = html`<p class="muted center-pad">Opening the office…</p>`;
  else if (page === 'host') out = hostView();
  else out = playerView();
  const str = String(out);

  const hostHome = page === 'host' && S.tab === 'home' && !!S.data && !S.loadError;
  $main.classList.toggle('wide', hostHome);
  $main.classList.toggle('landing-main', page === 'landing' && S.tab === 'home');
  if (str !== lastHtml) {
    const active = document.activeElement;
    const key = active?.dataset?.key;
    const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const scrollY = window.scrollY;
    $main.innerHTML = str;
    lastHtml = str;
    // Widths are set through the CSSOM because the CSP forbids inline style attributes.
    for (const bar of $main.querySelectorAll('[data-pct]')) bar.style.width = `${Math.max(0, Math.min(100, Number(bar.dataset.pct) || 0))}%`;
    if (key) {
      const el = $main.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (el) { el.focus({ preventScroll: true }); if (sel && 'setSelectionRange' in el) { try { el.setSelectionRange(...sel); } catch { /* not a text input */ } } }
    }
    const viewKey = `${page}|${S.tab}|${S.data?.phase}|${S.data?.viewer}`;
    if (viewKey !== lastViewKey) {
      $main.classList.remove('enter'); void $main.offsetWidth; $main.classList.add('enter');
      if (lastViewKey) window.scrollTo(0, 0);
      lastViewKey = viewKey;
    } else {
      window.scrollTo(0, scrollY);
    }
  }

  const d = S.data;
  $topRight.innerHTML = String(page !== 'landing' && d
    ? html`<span class="room-tag" aria-label="Room ${d.code}">${d.code}</span><span class="phase-tab">${d.phaseName}</span>`
    : '');
  for (const t of document.querySelectorAll('.tab')) {
    if (t.dataset.nav === S.tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  // On the player's own device the tab title names their seat, which helps when switching between tabs.
  const seat = d?.me?.label ? `Employer ${d.me.label} (${d.me.name})` : d?.me ? d.me.name : 'Play';
  document.title = page === 'landing' ? 'The Referral Rush'
    : `${S.tab === 'rules' ? 'Rules' : page === 'host' ? 'Host' : seat}, room ${S.route.code}: The Referral Rush`;
}

// ---------- events ----------
document.addEventListener('input', (e) => {
  const k = e.target.dataset?.bind;
  if (!k) return;
  let v = e.target.value;
  if (k === 'code') { v = v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); e.target.value = v; }
  if (k === 'claim') { v = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); e.target.value = v; }
  S.ui[k] = v;
  S.ui.formError = '';
});
document.addEventListener('change', (e) => {
  const k = e.target.dataset?.bind;
  if (k === 'refEmployee') { S.ui.refEmployee = e.target.value; S.ui.refTargets = []; render(); }
  if (k === 'refTargets') {
    const set = new Set(S.ui.refTargets);
    if (e.target.checked) set.add(e.target.value); else set.delete(e.target.value);
    S.ui.refTargets = [...set];
    render();
  }
});
document.addEventListener('toggle', (e) => {
  const key = e.target.dataset?.fold;
  if (!key) return;
  if (e.target.open) { S.ui.open.add(key); S.ui.open.delete(`!${key}`); }
  else { S.ui.open.delete(key); S.ui.open.add(`!${key}`); }
  lastHtml = ''; // the DOM now differs from the cached string
}, true);

document.addEventListener('submit', async (e) => {
  const form = e.target.dataset?.form;
  if (!form) return;
  e.preventDefault();
  if (S.busy) return;
  if (form === 'join-landing' || form === 'join-room') {
    const code = form === 'join-room' ? S.route.code : S.ui.code;
    if (!/^[A-Z]{4}$/.test(code)) { S.ui.formError = 'Enter the 4-letter room code.'; return render(); }
    if (!S.ui.name.trim()) { S.ui.formError = 'Enter your name.'; return render(); }
    S.busy = true; render();
    try {
      await api(`/api/rooms/${code}/join`, { method: 'POST', body: { name: S.ui.name } });
      S.busy = false;
      S.ui.formError = '';
      if (form === 'join-landing') return go(`/room/${code}`);
      history.replaceState({}, '', `/room/${code}`);
      return load();
    } catch (err) {
      S.ui.formError = err.message;
    }
    S.busy = false; render();
  }
  if (form === 'reclaim') {
    S.busy = true; render();
    try {
      await api(`/api/rooms/${S.route.code}/reclaim`, { method: 'POST', body: { claimCode: S.ui.claim } });
      S.ui.claim = '';
      toast('Welcome back.');
      history.replaceState({}, '', `/room/${S.route.code}`);
    } catch (err) { toast(err.message, true); }
    S.busy = false;
    load();
  }
  if (form === 'referral') {
    S.ui.confirmRef = true; render();
  }
});

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    S.tab = nav.dataset.nav;
    render();
    $main.focus({ preventScroll: true });
    return;
  }
  const link = e.target.closest('a[data-link]');
  if (link) { e.preventDefault(); go(link.getAttribute('href')); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  switch (act) {
    case 'resume': { const last = storage.get('rr_last'); go(`/${last.as === 'host' ? 'host' : 'room'}/${last.code}`); break; }
    case 'create-room': {
      S.busy = true; render();
      try { const r = await api('/api/rooms', { method: 'POST', body: {} }); S.busy = false; go(`/host/${r.code}`); }
      catch (err) { S.busy = false; toast(err.message, true); render(); }
      break;
    }
    case 'retry': load(); break;
    case 'flip': {
      // The badge flips once; it only reveals what this player's own state already contains.
      storage.set(seenKey(), true);
      render();
      break;
    }
    case 'ref-cancel': S.ui.confirmRef = false; render(); break;
    case 'ref-all': {
      const sent = new Set(S.data.employer.referralsSent.filter((r) => r.label === S.ui.refEmployee).map((r) => r.to));
      S.ui.refTargets = S.data.employers.map((x) => x.label).filter((l) => l !== S.data.me.label && !sent.has(l));
      render();
      break;
    }
    case 'ref-send': sendReferrals(); break;
    case 'hire-ask': S.ui.confirmHire = el.dataset.candidate; render(); break;
    case 'hire-cancel': S.ui.confirmHire = ''; render(); break;
    case 'hire': {
      const label = el.dataset.candidate;
      const r = await playerAct('hire', { candidate: label }, { quiet: !reducedMotion() });
      S.ui.confirmHire = '';
      if (r?.ok && !r.replayed) showFlash('hired', { employer: S.data.me.label, label: r.candidate, name: r.name });
      render();
      break;
    }
    case 'copy': copy(el.dataset.text); break;
    case 'advance': {
      const d = S.data;
      if (d.phase === 'hiring' || (d.phase !== 'lobby' && d.host.warnings.length)) {
        S.ui.confirmAdvance = { from: d.phase, warnings: d.host.warnings };
        render();
      } else {
        hostAct('advance', { from: d.phase });
      }
      break;
    }
    case 'advance-cancel': S.ui.confirmAdvance = null; render(); break;
    case 'advance-confirm': {
      const from = S.ui.confirmAdvance?.from;
      S.ui.confirmAdvance = null;
      hostAct('advance', { from, confirm: true });
      break;
    }
    case 'reset-ask': S.ui.confirmReset = true; render(); break;
    case 'reset-cancel': S.ui.confirmReset = false; render(); break;
    case 'reset-confirm': S.ui.confirmReset = false; S.ui.rejoin = {}; hostAct('reset', { confirm: true }); break;
    case 'remove': hostAct('remove', { playerId: id }); break;
    case 'rejoin': {
      const r = await hostAct('rejoin_code', { playerId: id });
      if (r?.claimCode) { S.ui.rejoin[id] = r.claimCode; render(); }
      break;
    }
    default: break;
  }
});

start();
