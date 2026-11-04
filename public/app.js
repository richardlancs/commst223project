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
    refEmployee: '', refTo: '', confirmRef: false,
    confirmAccept: '',
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
      S.ui.confirmAdvance = null; S.ui.confirmRef = false; S.ui.confirmAccept = '';
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
        <p class="slip-body"><strong>${data.label}, ${data.name}</strong> sent to Employer ${data.to}</p>
        <div class="stamp-spot"><span class="stamp thunk">REFERRED</span></div></div>`
    : html`<div class="letter"><div class="letterhead"><span class="seal">${data.employer}</span><span><strong>Employer ${data.employer}</strong><span>Offer of employment</span></span></div>
        <p>Welcome aboard. This position is yours.</p><div class="stamp-spot"><span class="stamp thunk">HIRED</span></div></div>`);
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
const others = (label) => ['A', 'B', 'C'].filter((e) => e !== label);
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
  const best = r.totals.find((t) => t.employer === r.winners[0]).total;
  const line = tie
    ? `Employers ${r.winners.join(' and ')} tie with ${plural(best, 'point')} each.`
    : `Employer ${r.winners[0]} wins with ${plural(best, 'point')}.`;
  return html`<section class="summary" aria-labelledby="sum-title">
    <div class="summary-head"><h2 id="sum-title">Hiring summary</h2><span class="count">Room ${S.data.code}</span></div>
    <p class="winner-line">${line}</p>
    <ul class="tally">${r.totals.map((t) => {
      const won = r.winners.includes(t.employer);
      return html`<li>${idchip(t.employer)}
        <span class="stack tight"><span class="who">${employerName(t.employer)}, ${t.filled} of ${r.hires} hired</span>
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
  return fold('roster', 'Staff directory', plural(d.employers.length + d.employees.length, 'person', 'people'), html`
    <h3>Employers</h3>
    <ul class="files">${d.employers.map((e) => html`<li>${idchip(e.label)}<span class="grow name">${e.name}</span></li>`)}</ul>
    <h3>Employees</h3>
    <ul class="files">${d.employees.map((e) => html`<li>${idchip(e.label)}<span class="grow name">${e.name}</span>${e.hired ? html`<span class="tag tag-ok">Hired</span>` : ''}</li>`)}</ul>`);
}

function setupBox(setup) {
  if (!setup.ready) {
    return html`<div class="notice notice-accent">${setup.players} signed in. ${plural(setup.needed, 'more player')} needed to start (minimum ${S.data.minPlayers}; 9 or more is best).</div>`;
  }
  return html`<div class="limit-box">
    <div><strong>${setup.players}</strong>players</div>
    <div><strong>3</strong>employers</div>
    <div><strong>${setup.employees}</strong>employees</div>
    <div><strong>${setup.hires}</strong>${setup.hires === 1 ? 'hire' : 'hires'} and ${setup.hires === 1 ? 'referral' : 'referrals'} each</div>
  </div>
  <p class="small muted">Private information groups of ${setup.groupSizes.join(', ')}.</p>`;
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
      <p class="muted desc">A party game for one room and everyone's phones. Three employers are hiring. Everyone else wants the job. Who will you vouch for?</p>
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

// ---------- player ----------
function phaseInstruction() {
  const role = S.data.me?.role;
  return {
    lobby: 'Waiting for the host to assign roles.',
    reveal: role === 'employer' ? 'Tap your badge, then study your private file.' : 'Tap your badge to see your role.',
    networking: role === 'employer' ? 'Send your referrals and negotiate in person.' : 'Talk to employers and make your case in person.',
    hiring: role === 'employer' ? 'Make job offers. Employees accept or decline.' : 'Answer your job offers.',
    results: 'The hiring results are in.',
    discussion: 'Debrief together.',
  }[S.data.phase];
}

function idCard(me, objective) {
  const seen = storage.get(seenKey()) === true;
  const roleName = me.role === 'employer' ? 'Employer' : 'Employee';
  if (S.data.phase === 'reveal') {
    return html`<div class="badge-wrap">
      <button class="badge" data-act="flip" data-key="badge" aria-pressed="${seen ? 'true' : 'false'}"
        aria-label="${seen ? `Your role: ${roleName} ${me.label}. ${objective}` : 'Tap to reveal your role'}">
        <span class="badge-inner">
          <span class="badge-face badge-back" aria-hidden="${seen ? 'true' : 'false'}">
            <span class="seal">Referral Rush Inc.</span>
            <span class="hint">Tap to reveal your role</span>
            <span class="small">Keep your screen to yourself</span>
          </span>
          <span class="badge-face badge-front" aria-hidden="${seen ? 'false' : 'true'}">
            <span class="band">Referral Rush Inc. staff ID</span>
            <span class="body">
              <span class="badge-role">${roleName}</span>
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
    <span class="id-text"><strong>${roleName} ${me.label}</strong><span class="muted">${me.name}. ${objective}</span></span>
  </div>`;
}

function employerHome() {
  const d = S.data; const me = d.me; const x = d.employer; const H = x.hires;
  const parts = [idCard(me, 'Goal: hire the highest total score.')];
  if (d.phase === 'reveal' && storage.get(seenKey()) !== true) { parts.push(wait('Tap the badge to see your role.')); return parts; }

  const groupFile = html`<div class="folder"><span class="folder-tab">Private file: Group ${me.label}</span>
    <div class="folder-body">
      <p class="folder-note">You know these scores. You cannot hire these employees.</p>
      <ul class="files">${x.group.map((g) => html`<li>${idchip(g.label)}<span class="grow name">${g.name}</span>${grade(g.score)}</li>`)}</ul>
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
      <p class="instruction">Finish with the highest combined score from your hires.</p>
      <p>You will hire <strong>${plural(H, 'employee')}</strong> and must give <strong>${plural(H, 'referral')}</strong> to rival employers.</p></section>`);
    parts.push(groupFile);
    parts.push(wait('Waiting for the host to open networking.'));
  }

  if (d.phase === 'networking') {
    const sent = x.referralsSent.length;
    const left = H - sent;
    const referred = new Set(x.referralsSent.map((r) => r.label));
    const available = x.group.filter((g) => !referred.has(g.label));
    let form = '';
    if (left > 0) {
      const pick = x.group.find((g) => g.label === S.ui.refEmployee && !referred.has(g.label));
      const to = others(me.label).includes(S.ui.refTo) ? S.ui.refTo : '';
      form = S.ui.confirmRef && pick && to
        ? html`<div class="slip stack" role="alertdialog" aria-labelledby="ref-confirm-title">
            <p class="slip-head" id="ref-confirm-title">Check the slip before you send it</p>
            <p class="slip-body">Employer ${me.label} recommends <strong>${pick.label}, ${pick.name}</strong> to Employer ${to}. Candidate score: <strong>${pick.score}</strong>.</p>
            <p class="small muted">Referrals cannot be edited or withdrawn.</p>
            <div class="btn-row">
              <button class="btn btn-secondary" data-act="ref-cancel" data-key="ref-cancel">Back</button>
              <button class="btn btn-primary" data-act="ref-send" data-key="ref-send" ${disabled(S.busy)}>${S.busy ? 'Sending…' : 'Send referral'}</button>
            </div>
          </div>`
        : html`<form class="stack" data-form="referral" novalidate>
            <fieldset class="choices">
              <legend>Who are you recommending?</legend>
              ${available.map((g) => html`<label class="choice"><input type="radio" name="refEmployee" value="${g.label}" data-bind="refEmployee" ${g.label === S.ui.refEmployee ? new Raw('checked') : ''}>
                <span>${idchip(g.label)}<span class="grow">${g.name}</span>${grade(g.score)}</span></label>`)}
            </fieldset>
            <fieldset class="choices">
              <legend>Send it to</legend>
              <div class="seg">${others(me.label).map((e) => html`<label class="choice"><input type="radio" name="refTo" value="${e}" data-bind="refTo" ${e === to ? new Raw('checked') : ''}>
                <span>Employer ${e}</span></label>`)}</div>
            </fieldset>
            <button class="btn btn-primary" type="submit" data-key="ref-review" ${disabled(!pick || !to)}>Review referral</button>
          </form>`;
    }
    parts.push(html`<section class="stack">
      <div class="section-title"><h2>Write a referral</h2><span class="count">${sent} of ${H} sent</span></div>
      ${left > 0 ? html`<p class="muted">Send ${plural(left, 'more referral')}. Each must be a different person from your file. The slip shows their true score.</p>`
        : html`<div class="notice notice-ok">${H === 1 ? 'Your referral is sent.' : `All ${H} referrals are sent.`}</div>`}
      ${form}
    </section>`);
    parts.push(html`<section class="stack"><div class="section-title"><h2>Recommendations received</h2><span class="count">${x.referralsReceived.length}</span></div>${receivedSlips}</section>`);
    parts.push(html`<div class="folds">${fold('sent', 'Referrals you sent', `${sent}`, sentSlips, sent > 0)}</div>`);
    parts.push(groupFile);
    if (left === 0) parts.push(wait('Waiting for the host to open hiring.'));
  }

  if (d.phase === 'hiring') {
    const pending = x.offers.filter((o) => o.status === 'pending');
    const free = H - x.slotsUsed;
    const slots = [];
    x.hired.forEach((h) => slots.push(html`<div class="slot filled"><span class="slot-label">Filled</span>
      <span class="slot-state">${h.label}, ${h.name}</span>
      <span class="small">${h.score == null ? 'Score: awaiting reveal' : `Score ${h.score}`}</span></div>`));
    pending.forEach((o) => slots.push(html`<div class="slot pending"><span class="slot-label">Offer pending</span>
      <span class="slot-state">${o.label}, ${o.name}</span>
      <button class="btn btn-secondary btn-small" data-act="withdraw" data-id="${o.id}" data-key="wd-${o.id}" ${disabled(S.busy)}>Withdraw</button></div>`));
    for (let i = 0; i < free; i++) slots.push(html`<div class="slot"><span class="slot-label">Open position</span><span class="slot-state">Make an offer below</span></div>`);
    parts.push(html`<section class="stack">
      <div class="section-title"><h2>Job slots</h2><span class="count">${x.hired.length} of ${H} filled</span></div>
      <div class="slots">${slots}</div>
      ${free === 0 && x.hired.length < H ? html`<p class="small muted">Every open slot is held by a pending offer. Withdraw one to offer someone else.</p>` : ''}
    </section>`);
    const cands = x.candidates.filter((c) => !c.hiredByMe);
    parts.push(html`<section class="stack">
      <div class="section-title"><h2>Eligible candidates</h2><span class="count">${cands.filter((c) => !c.hired).length} available</span></div>
      <ul class="ledger">${cands.map((c) => {
        const tags = [];
        if (c.referredBy) tags.push(html`<span class="tag tag-accent">Referred by ${c.referredBy}</span>`);
        if (c.pendingOffer) tags.push(html`<span class="tag tag-warn">Your offer is pending</span>`);
        if (c.hired) tags.push(html`<span class="tag">Hired elsewhere</span>`);
        const canOffer = !c.hired && !c.pendingOffer && free > 0;
        return html`<li>${idchip(c.label)}<span class="grow"><span class="name">${c.name}</span>${tags.length ? html`<span class="tag-row">${tags}</span>` : ''}</span>
          ${c.hired ? '' : html`<span class="stack tight end">${grade(c.knownScore)}
          <button class="btn btn-primary btn-small" data-act="offer" data-employee="${c.label}" data-key="offer-${c.label}" ${disabled(!canOffer || S.busy)}>Offer job</button></span>`}</li>`;
      })}</ul>
      <p class="small muted">Your own group is not listed. Without a referral, a score is a guess.</p>
    </section>`);
    const past = x.offers.filter((o) => o.status !== 'pending');
    const label = { declined: 'Declined', withdrawn: 'Withdrawn', closed: 'Took another job', expired: 'Expired' };
    parts.push(html`<div class="folds">
      ${fold('received', 'Recommendations received', `${x.referralsReceived.length}`, receivedSlips)}
      ${past.length ? fold('past-offers', 'Earlier offers', `${past.length}`, html`<ul class="files">${past.map((o) => html`<li>${idchip(o.label)}<span class="grow name">${o.name}</span><span class="tag">${label[o.status]}</span></li>`)}</ul>`) : ''}
      ${fold('group', 'Private file: you cannot hire these', plural(x.group.length, 'person', 'people'), groupFile)}
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

function employeeHome() {
  const d = S.data; const me = d.me; const x = d.employee;
  const g = x.groupEmployer;
  const parts = [idCard(me, 'Goal: get hired.')];
  if (d.phase === 'reveal' && storage.get(seenKey()) !== true) { parts.push(wait('Tap the badge to see your role.')); return parts; }

  const knows = html`<div class="folder"><span class="folder-tab plain">Who has your file</span><div class="folder-body stack tight">
    <p class="instruction">Employer ${g.label}${g.name ? ` (${g.name})` : ''} knows your score.</p>
    <p>Employer ${g.label} cannot hire you, but can refer you to Employer ${others(g.label).join(' or ')}. You do not know your own score.</p>
  </div></div>`;
  const referralStatus = x.referrals.length
    ? html`<div class="slips">${x.referrals.map((r) => html`<div class="slip stamped"><p class="slip-head">From Employer ${r.from}</p>
        <p class="slip-body">You were referred to <strong>Employer ${r.to}</strong>.</p><span class="stamp">REFERRED</span></div>`)}</div>`
    : html`<p class="muted">No one has referred you yet.</p>`;

  if (d.phase === 'reveal') {
    parts.push(knows);
    parts.push(wait('Waiting for the host to open networking.'));
  }
  if (d.phase === 'networking') {
    parts.push(html`<section class="stack"><div class="section-title"><h2>Referral status</h2><span class="count">${x.referrals.length}</span></div>${referralStatus}
      <p class="small muted">Referrals never show you your own score.</p></section>`);
    parts.push(knows);
    parts.push(wait('Hiring opens when the host is ready.'));
  }
  if (d.phase === 'hiring') {
    if (x.job) {
      parts.push(html`<article class="letter" aria-label="Your accepted job">
        <div class="letterhead"><span class="seal">${x.job}</span><span><strong>Employer ${x.job}</strong><span>${employerName(x.job)}</span></span></div>
        <p class="instruction">You accepted this offer. The job is yours and the decision is final.</p>
        <div class="stamp-spot"><span class="stamp">HIRED</span></div></article>`);
      parts.push(wait('Waiting for the host to close hiring.'));
    } else {
      const pending = x.offers.filter((o) => o.status === 'pending');
      parts.push(html`<section class="stack"><div class="section-title"><h2>Job offers</h2><span class="count">${pending.length} open</span></div>
        ${pending.length ? pending.map((o) => html`<article class="letter" aria-labelledby="off-${o.id}">
          <div class="letterhead"><span class="seal">${o.from}</span><span><strong id="off-${o.id}">Offer from Employer ${o.from}</strong><span>${employerName(o.from)}</span></span></div>
          ${S.ui.confirmAccept === o.id
            ? html`<div role="alertdialog" aria-labelledby="acc-${o.id}" class="stack tight">
                <p class="instruction" id="acc-${o.id}">Accept Employer ${o.from}'s offer?</p>
                <p>Accepting is final. Your other offers will close.</p>
                <div class="btn-row">
                  <button class="btn btn-secondary" data-act="accept-cancel" data-key="acc-cancel">Back</button>
                  <button class="btn btn-primary" data-act="accept" data-id="${o.id}" data-key="acc-yes-${o.id}" ${disabled(S.busy)}>${S.busy ? 'Accepting…' : 'Accept job'}</button>
                </div></div>`
            : html`<p>We would like you to join Employer ${o.from}. Accept to take the job, or decline to keep looking.</p>
              <div class="btn-row">
                <button class="btn btn-secondary" data-act="decline" data-id="${o.id}" data-key="dec-${o.id}" ${disabled(S.busy)}>Decline</button>
                <button class="btn btn-primary" data-act="accept-ask" data-id="${o.id}" data-key="acc-${o.id}" ${disabled(S.busy)}>Accept</button>
              </div>`}
        </article>`) : wait(`No offers yet. Talk to Employer ${others(g.label).join(' and Employer ')}.`)}
      </section>`);
    }
    const past = x.offers.filter((o) => o.status !== 'pending');
    const label = { declined: 'You declined', withdrawn: 'Withdrawn', closed: 'Closed', expired: 'Expired' };
    parts.push(html`<div class="folds">
      ${past.length ? fold('past-offers', 'Earlier offers', `${past.length}`, html`<ul class="files">${past.map((o) => html`<li>${idchip(o.from)}<span class="grow">Employer ${o.from}</span><span class="tag">${label[o.status]}</span></li>`)}</ul>`) : ''}
      ${fold('refs', 'Referral status', `${x.referrals.length}`, referralStatus)}
    </div>`);
  }
  if (atLeast('results')) {
    parts.push(html`<section class="stack" aria-label="Your result">
      <div class="section-title"><h2>Your score</h2><span class="big-score">${x.score}</span></div>
      ${x.job ? html`<div class="notice notice-ok">Hired by Employer ${x.job}. You reached your goal.</div>` : html`<div class="notice notice-warn">Not hired this round.</div>`}
    </section>`);
    parts.push(summarySheet());
    if (d.phase === 'discussion') parts.push(discussionBlock());
    parts.push(html`<div class="folds">${fold('refs', 'Referral status', `${x.referrals.length}`, referralStatus)}</div>`);
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
  } else if (d.me.role === 'employer') body = employerHome();
  else body = employeeHome();
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
    phaseBody.push(html`<p class="muted">${plural(players.length, 'player')}: 3 employers and ${d.setup.employees} employees. Each employer hires ${d.setup.hires} and gives ${plural(d.setup.hires, 'referral')}.</p>`);
  }
  if (d.phase === 'reveal') phaseBody.push(wait('Players are reading their badges. Open networking when the room is ready.'));
  const progress = (key, label) => html`<div class="progress-rows">${h.progress.map((p) => html`<div class="progress-row">${idchip(p.employer)}
    <span class="bar" aria-hidden="true"><i data-pct="${Math.round((p[key] / d.setup.hires) * 100)}"></i></span>
    <span class="count">${p[key]} of ${d.setup.hires}${key === 'filled' && p.pending ? `, ${p.pending} pending` : ''}${p[key] >= d.setup.hires ? ' done' : ''}</span></div>`)}</div>`;
  if (d.phase === 'networking') {
    phaseBody.push(html`<section class="stack"><div class="section-title"><h2>Referrals sent</h2></div>${progress('referralsSent')}</section>`);
  }
  if (d.phase === 'hiring') {
    const pending = h.offers.filter((o) => o.status === 'pending');
    phaseBody.push(html`<section class="stack"><div class="section-title"><h2>Positions filled</h2></div>${progress('filled')}</section>`);
    afterPrimary.push(html`<div class="folds">${fold('pending', 'Outstanding offers', `${pending.length}`, pending.length
      ? html`<ul class="files">${pending.map((o) => html`<li>${idchip(o.employer)}<span class="grow">to <strong>${o.label}</strong> ${o.name}</span><span class="tag tag-warn">Pending</span></li>`)}</ul>`
      : html`<p class="muted">No offers waiting for an answer.</p>`, pending.length > 0)}</div>`);
  }
  if (atLeast('results')) {
    phaseBody.push(summarySheet());
    if (d.phase === 'discussion') phaseBody.push(discussionBlock());
  }

  let primary = '';
  // Live warnings, so the panel updates if players finish while the host is deciding.
  const confirm = S.ui.confirmAdvance && S.ui.confirmAdvance.from === d.phase ? { ...S.ui.confirmAdvance, warnings: h.warnings } : null;
  if (nextLabel) {
    primary = confirm
      ? html`<div class="slip stack" role="alertdialog" aria-labelledby="adv-title">
          <h3 id="adv-title">${confirm.warnings.length ? 'Some paperwork is unfinished' : `${nextLabel}?`}</h3>
          ${confirm.warnings.length ? html`<ul class="bullets">${confirm.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
          ${d.phase === 'hiring' ? html`<p class="muted">Pending offers will expire and the results will be shown to everyone. This cannot be undone.</p>` : html`<p class="muted">You can stay in ${d.phaseName.toLowerCase()} or continue anyway.</p>`}
          <div class="btn-row">
            <button class="btn btn-secondary" data-act="advance-cancel" data-key="adv-cancel">Stay in ${d.phaseName.toLowerCase()}</button>
            <button class="btn btn-primary" data-act="advance-confirm" data-key="adv-confirm" ${disabled(S.busy)}>${d.phase === 'hiring' ? 'Reveal results' : 'Continue anyway'}</button>
          </div></div>`
      : html`<div class="stack tight">
          <button class="btn btn-primary" data-act="advance" data-key="advance" ${disabled(!canAdvance || S.busy)}>${nextLabel}</button>
          ${blockReason ? html`<p class="small muted">${blockReason}</p>` : h.warnings.length ? html`<p class="small muted">${h.warnings[0]}${h.warnings.length > 1 ? ` (+${h.warnings.length - 1} more)` : ''}</p>` : ''}
        </div>`;
  }

  const priv = d.phase === 'lobby' ? '' : fold('private', 'Private: assignments and scores', 'Host only', html`<div class="stack">
    <p class="small muted">Keep this section off the projector.</p>
    ${['A', 'B', 'C'].map((e) => {
      const emp = h.members.find((m) => m.role === 'employer' && m.label === e);
      const group = h.members.filter((m) => m.role === 'employee' && m.group === e).sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
      return html`<div class="folder"><span class="folder-tab">Employer ${e}: ${emp?.name}${h.preview ? `, ${h.preview.totals.find((t) => t.employer === e).total} pts` : ''}</span><div class="folder-body">
        <ul class="files">${group.map((m) => html`<li>${idchip(m.label)}<span class="grow"><span class="name">${m.name}</span>${m.hiredBy ? html`<span class="tag-row"><span class="tag tag-ok">Hired by ${m.hiredBy}</span></span>` : ''}</span>${grade(m.score)}</li>`)}</ul></div></div>`;
    })}
    ${h.referrals.length ? html`<div class="stack tight"><h3>Referrals</h3><ul class="files">${h.referrals.map((r) => html`<li>${idchip(r.from)}<span class="grow">${r.label} ${r.name} to Employer ${r.to}</span>${grade(r.score)}</li>`)}</ul></div>` : ''}
    ${h.preview && !atLeast('results') ? html`<p class="small muted">Current totals preview: ${h.preview.totals.map((t) => `${t.employer} ${t.total}`).join(', ')}. Players cannot see this.</p>` : ''}
  </div>`);

  const people = fold('people', 'Players and rejoin codes', plural(h.members.length, 'person', 'people'), html`<div class="stack">
    <p class="small muted">If someone switches phones or browsers, give them a rejoin code. It works once and expires in 15 minutes.</p>
    <ul class="ledger">${h.members.map((m) => html`<li><span class="grow"><span class="name">${m.name}</span>
      <span class="tag-row">${m.spectator ? html`<span class="tag">Observer</span>` : m.label ? html`<span class="tag">${m.role === 'employer' ? 'Employer' : 'Employee'} ${m.label}</span>` : ''}
      ${S.ui.rejoin[m.id] ? html`<span class="tag tag-warn">Code: <span class="mono">${S.ui.rejoin[m.id]}</span></span>` : ''}</span></span>
      <span class="row tight">
      <button class="btn btn-secondary btn-small" data-act="rejoin" data-id="${m.id}" data-key="rj-${m.id}" ${disabled(S.busy)}>Rejoin code</button>
      ${m.spectator || d.phase === 'lobby' ? html`<button class="btn btn-secondary btn-small" data-act="remove" data-id="${m.id}" data-key="rmx-${m.id}" aria-label="Remove ${m.name}" ${disabled(S.busy)}>Remove</button>` : ''}
      </span></li>`)}</ul>
    ${spectators.length && d.phase !== 'lobby' ? html`<p class="small muted">${plural(spectators.length, 'observer')} will become players after a reset.</p>` : ''}
  </div>`);

  const resetPanel = fold('reset', d.phase === 'discussion' ? 'Play again' : 'Reset game', null, S.ui.confirmReset
    ? html`<div class="stack"><p><strong>Reset the game?</strong> Roles, referrals, offers and results will be erased. Everyone goes back to the lobby, and observers become players.</p>
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
  const H = s?.ready ? s.hires : null;
  const n = (word) => (H ? plural(H, word) : `the room's number of ${word}s`);
  return html`<div class="stack-lg handbook">
    <section class="stack">
      <p class="clause">Employee handbook, rev. Q4</p>
      <h1>Rules</h1>
      <p class="lede">Talk in person. Use your phone to see your role, send referrals and answer job offers.</p>
      ${H ? html`<div class="limit-box"><div><strong>${H}</strong>${H === 1 ? 'hire' : 'hires'} per employer</div><div><strong>${H}</strong>${H === 1 ? 'referral' : 'referrals'} per employer</div></div>`
          : html`<p class="muted">Each employer hires 1 employee for every 5 employees in the room (at least 1), and gives the same number of referrals.</p>`}
    </section>
    <section class="stack">
      <h2>Goals</h2>
      <ul>
        <li><strong>Employers</strong> want the highest combined score from their hires. Nothing else counts.</li>
        <li><strong>Employees</strong> want to get hired.</li>
      </ul>
    </section>
    <section class="stack">
      <h2>Confidential information</h2>
      <ul>
        <li>There are three employers: A, B and C. Everyone else is an employee.</li>
        <li>Every employee has a secret score from 1 to 10. Employees do not know their own score.</li>
        <li>Each employer holds the file for one group of employees and <strong>cannot hire anyone in that group</strong>.</li>
      </ul>
    </section>
    <section class="stack">
      <h2>How the day goes</h2>
      <ol>
        <li><strong>Role reveal.</strong> Tap your badge to see your role.</li>
        <li><strong>Networking.</strong> Each employer must send ${n('referral')}, each about a different person in their file, to either rival employer. A referral shows the person's true score and cannot be changed or taken back.</li>
        <li><strong>Hiring.</strong> Each employer fills ${n('position')}. Employers make offers; employees accept or decline. A pending offer holds a position. Accepting is final.</li>
        <li><strong>Results.</strong> An employer's score is the total of their hires' scores. Empty positions score zero. Highest total wins; ties share the win.</li>
        <li><strong>Debrief.</strong> Talk about what happened.</li>
      </ol>
    </section>
    <section class="stack">
      <h2>Good to know</h2>
      <ul>
        <li>Deals happen out loud. There is no chat in the app.</li>
        <li>A referral does not guarantee a job. Employers can hire someone without one, but then the score is a guess.</li>
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
  document.title = page === 'landing' ? 'The Referral Rush' : `${S.tab === 'rules' ? 'Rules' : page === 'host' ? 'Host' : 'Play'}, room ${S.route.code}: The Referral Rush`;
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
  if (k === 'refEmployee' || k === 'refTo') { S.ui[k] = e.target.value; render(); }
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
    case 'ref-send': {
      const pick = S.data.employer?.group.find((g) => g.label === S.ui.refEmployee);
      const sentTo = S.ui.refTo;
      const r = await playerAct('referral', { employee: S.ui.refEmployee, to: sentTo }, { quiet: !reducedMotion() });
      S.ui.confirmRef = false;
      // Celebrate only once the server has confirmed it, and never for a replayed request.
      if (r?.ok && !r.replayed && pick) showFlash('referred', { from: S.data.me.label, to: sentTo, label: pick.label, name: pick.name });
      if (r?.ok) { S.ui.refEmployee = ''; }
      render();
      break;
    }
    case 'offer': playerAct('offer', { employee: el.dataset.employee }); break;
    case 'withdraw': playerAct('withdraw', { offerId: id }); break;
    case 'accept-ask': S.ui.confirmAccept = id; render(); break;
    case 'accept-cancel': S.ui.confirmAccept = ''; render(); break;
    case 'accept': {
      const from = S.data.employee?.offers.find((o) => o.id === id)?.from;
      const r = await playerAct('accept', { offerId: id }, { quiet: !reducedMotion() });
      S.ui.confirmAccept = '';
      if (r?.ok && !r.replayed && from) showFlash('hired', { employer: from });
      render();
      break;
    }
    case 'decline': playerAct('decline', { offerId: id }); break;
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
