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
  },
};
let es = null;
let lastHtml = '';
let lastViewKey = '';
let lastPhase = null;
let toastTimer = null;
let pollTimer = null;

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
    if (lastPhase && lastPhase !== S.data.phase) {
      announce(`Phase changed: ${S.data.phaseName}`);
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
async function playerAct(type, payload = {}) {
  if (S.busy) return;
  S.busy = true; render();
  try {
    const r = await postAction(`/api/rooms/${S.route.code}/action`, { type, requestId: requestId(), ...payload });
    if (r.message) toast(r.message);
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
function announce(message) { toast(message); }

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

// ---------- shared bits ----------
const DISCUSSION = [
  'Did you recommend strong candidates or protect your advantage?',
  'Did anyone offer help mainly to get something back?',
  'How did it feel to depend on someone who had little incentive to help?',
  'What would change if the goal were helping everyone find work?',
];
const phaseOrder = ['lobby', 'reveal', 'networking', 'hiring', 'results', 'discussion'];
const atLeast = (phase) => S.data && phaseOrder.indexOf(S.data.phase) >= phaseOrder.indexOf(phase);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const disabled = (cond) => (cond ? new Raw('disabled') : '');
const others = (label) => ['A', 'B', 'C'].filter((e) => e !== label);
const employerName = (label) => S.data?.employers?.find((e) => e.label === label)?.name || '';

function fold(key, title, meta, body, defaultOpen = false) {
  const open = S.ui.open.has(key) || (defaultOpen && !S.ui.open.has(`!${key}`));
  return html`<details class="fold" data-fold="${key}" ${open ? new Raw('open') : ''}>
    <summary>${title}${meta != null ? html`<span class="summary-meta">${meta}</span>` : ''}</summary>
    <div class="fold-body">${body}</div>
  </details>`;
}
const wait = (text) => html`<div class="wait"><span class="dot" aria-hidden="true"></span><span>${text}</span></div>`;
const scoreBadge = (score, label = 'score') => (score == null
  ? html`<span class="score-unknown">Score unknown</span>`
  : html`<span class="score" aria-label="${label} ${score} out of 10">${score}<small>/10</small></span>`);

function resultsBlock() {
  const r = S.data.results;
  if (!r) return '';
  const max = Math.max(1, ...r.totals.map((t) => t.total));
  const tie = r.winners.length > 1;
  const winnerText = tie
    ? `Employers ${r.winners.join(' and ')} tie`
    : `Employer ${r.winners[0]} wins`;
  const best = r.totals.find((t) => t.employer === r.winners[0]).total;
  return html`
    <section class="winner" aria-label="Winner">
      <p>${tie ? 'Shared win' : 'Winner'}</p>
      <p class="big">${winnerText}</p>
      <p>with ${plural(best, 'point')}${tie ? ' each' : ''}</p>
    </section>
    <section class="panel">
      <h2>Employer totals</h2>
      <ul class="bars">
        ${r.totals.map((t) => html`<li>
          <span class="chip">${t.employer}</span>
          <span><span class="bar" aria-hidden="true"><i data-pct="${Math.round((t.total / max) * 100)}"></i></span>
            <span class="small muted">${employerName(t.employer)}: ${t.filled} of ${r.hires} hired</span></span>
          <span class="score">${t.total}</span>
        </li>`)}
      </ul>
    </section>`;
}

function discussionBlock() {
  return html`<section class="panel">
    <h2>Talk it over</h2>
    <ol class="stack" class="q-list">${DISCUSSION.map((q) => html`<li class="instruction">${q}</li>`)}</ol>
  </section>`;
}

function rosterFold() {
  const d = S.data;
  if (!d.employers) return '';
  return fold('roster', "Who's who", plural(d.employers.length + d.employees.length, 'player'), html`
    <h3>Employers</h3>
    <ul class="list">${d.employers.map((e) => html`<li><span class="chip">${e.label}</span><span class="grow name">${e.name}</span></li>`)}</ul>
    <h3 class="mt">Employees</h3>
    <ul class="list">${d.employees.map((e) => html`<li><span class="chip">${e.label}</span><span class="grow name">${e.name}</span>${e.hired ? html`<span class="tag tag-ok">Hired</span>` : ''}</li>`)}</ul>`);
}

function setupBox(setup) {
  if (!setup.ready) {
    return html`<div class="notice notice-accent">${setup.players} joined. ${plural(setup.needed, 'more player')} needed to start (minimum ${S.data.minPlayers}, 9 or more is best).</div>`;
  }
  return html`<div class="limit-box">
    <div><strong>${setup.players}</strong>players</div>
    <div><strong>${setup.employees}</strong>employees</div>
    <div><strong>3</strong>employers</div>
    <div><strong>${setup.hires}</strong>${setup.hires === 1 ? 'hire' : 'hires'} per employer</div>
  </div>
  <p class="small muted">Information groups of ${setup.groupSizes.join(', ')}.</p>`;
}

// ---------- landing & join ----------
function landingView() {
  const last = storage.get('rr_last');
  return html`<div class="stack-lg">
    <section class="hero">
      <h1>The Referral Rush</h1>
      <p class="lede">Get hired. Hire well. Decide who you will vouch for, and who you will not.</p>
    </section>
    ${last?.code ? html`<button class="btn btn-secondary" data-act="resume" data-key="resume">Return to room ${last.code}</button>` : ''}
    <form class="stack" data-form="join-landing" novalidate>
      <h2>Join a game</h2>
      <div class="field">
        <label for="code">Room code</label>
        <input class="input input-code" id="code" name="code" data-bind="code" data-key="code" value="${S.ui.code}"
          maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" required>
      </div>
      <div class="field">
        <label for="name">Your name</label>
        <input class="input" id="name" name="name" data-bind="name" data-key="name" value="${S.ui.name}" maxlength="20" autocomplete="nickname" required>
      </div>
      ${S.ui.formError ? html`<p class="form-error" role="alert">${S.ui.formError}</p>` : ''}
      <button class="btn btn-primary" type="submit" data-key="join" ${disabled(S.busy)}>Join game</button>
    </form>
    <div class="divider">or</div>
    <div class="stack">
      <button class="btn btn-secondary" data-act="create-room" data-key="create" ${disabled(S.busy)}>Host a new game</button>
      <p class="small muted">The host runs the game from their own screen and does not play.</p>
    </div>
  </div>`;
}

function joinView() {
  const d = S.data;
  const started = d.phase !== 'lobby';
  return html`<div class="stack-lg">
    <section class="hero">
      <p class="muted">Room</p>
      <p class="room-code">${d.code}</p>
    </section>
    ${started ? html`<div class="notice notice-warn">This game has already started. You can join as a spectator and see public updates. The host can add you as a player after a reset.</div>` : ''}
    <form class="stack" data-form="join-room" novalidate>
      <div class="field">
        <label for="name">Your name</label>
        <input class="input" id="name" name="name" data-bind="name" data-key="name" value="${S.ui.name}" maxlength="20" autocomplete="nickname" required>
      </div>
      ${S.ui.formError ? html`<p class="form-error" role="alert">${S.ui.formError}</p>` : ''}
      <button class="btn btn-primary" type="submit" data-key="join" ${disabled(S.busy)}>${started ? 'Watch as spectator' : 'Join game'}</button>
    </form>
    ${fold('claim', 'Already joined on another phone?', null, html`<form class="stack" data-form="reclaim" novalidate>
      <p class="muted">Ask the host for a rejoin code, then enter it here to get your role back.</p>
      <div class="field">
        <label for="claim">Rejoin code</label>
        <input class="input input-code" id="claim" data-bind="claim" data-key="claim" value="${S.ui.claim}" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false">
      </div>
      <button class="btn btn-secondary" type="submit" data-key="reclaim" ${disabled(S.busy)}>Rejoin</button>
    </form>`)}
  </div>`;
}

// ---------- player ----------
function phaseInstruction() {
  const d = S.data;
  const role = d.me?.role;
  const map = {
    lobby: 'Waiting for the host to assign roles.',
    reveal: role === 'employer' ? 'Tap your card, then study your group.' : 'Tap your card to see your role.',
    networking: role === 'employer' ? 'Send your referrals. Negotiate in person.' : role === 'employee' ? 'Talk to employers. Make your case in person.' : 'Players are negotiating and sending referrals.',
    hiring: role === 'employer' ? 'Make job offers to employees.' : role === 'employee' ? 'Accept or decline job offers.' : 'Employers are making offers.',
    results: 'The scores are in.',
    discussion: 'Talk it over as a group.',
  };
  return map[d.phase];
}

function idCard(me, sub) {
  const revealedKey = `rr_seen_${S.data.code}_${S.data.round}`;
  const seen = storage.get(revealedKey) === true;
  if (S.data.phase === 'reveal') {
    return html`<div class="badge-wrap">
      <button class="badge" data-act="flip" data-key="badge" aria-pressed="${seen ? 'true' : 'false'}"
        aria-label="${seen ? `Your role: ${me.role === 'employer' ? 'Employer' : 'Employee'} ${me.label}` : 'Tap to reveal your role'}">
        <span class="badge-inner">
          <span class="badge-face badge-back" aria-hidden="${seen ? 'true' : 'false'}"><span class="q">?</span><span class="hint">Tap to reveal your role</span><span class="small">Keep your screen to yourself</span></span>
          <span class="badge-face badge-front" aria-hidden="${seen ? 'false' : 'true'}">
            <span class="badge-role">${me.role === 'employer' ? 'Employer' : 'Employee'}</span>
            <span class="badge-label">${me.label}</span>
            <span class="badge-name">${me.name}</span>
            <span class="badge-foot">${sub}</span>
          </span>
        </span>
      </button>
    </div>`;
  }
  return html`<div class="id-strip">
    <span class="id-glyph" aria-hidden="true">${me.label}</span>
    <span class="id-text"><strong>${me.role === 'employer' ? 'Employer' : 'Employee'} ${me.label}</strong><span class="muted">${me.name}. ${sub}</span></span>
  </div>`;
}

function employerHome() {
  const d = S.data; const me = d.me; const x = d.employer; const H = x.hires;
  const revealedCard = d.phase !== 'reveal' || storage.get(`rr_seen_${d.code}_${d.round}`) === true;
  const parts = [idCard(me, 'Goal: hire the highest total score.')];
  if (!revealedCard) { parts.push(wait('Tap the card to see your role.')); return parts; }

  const groupList = html`<p class="muted small mb">You know these scores. You cannot hire these employees.</p>
    <ul class="list">${x.group.map((g) => html`<li><span class="chip">${g.label}</span><span class="grow name">${g.name}</span>${scoreBadge(g.score)}</li>`)}</ul>`;
  const groupFold = (open) => fold('group', 'Your group: you cannot hire these employees', plural(x.group.length, 'person', 'people'), groupList, open);
  const receivedList = x.referralsReceived.length
    ? html`<ul class="list">${x.referralsReceived.map((r) => html`<li><span class="chip">${r.label}</span><span class="grow"><span class="name">${r.name}</span><span class="tagline"><span class="tag">From Employer ${r.from}</span></span></span>${scoreBadge(r.score)}</li>`)}</ul>`
    : html`<p class="muted">No referrals received yet.</p>`;
  const sentList = x.referralsSent.length
    ? html`<ul class="list">${x.referralsSent.map((r) => html`<li><span class="chip">${r.label}</span><span class="grow"><span class="name">${r.name}</span><span class="tagline"><span class="tag">To Employer ${r.to}</span></span></span>${scoreBadge(r.score)}</li>`)}</ul>`
    : html`<p class="muted">You have not sent any referrals yet.</p>`;

  if (d.phase === 'reveal') {
    parts.push(html`<section class="panel stack">
      <h2>Your job</h2>
      <p>Finish with the highest combined score from your hires. You will hire <strong>${plural(H, 'employee')}</strong> and must give <strong>${plural(H, 'referral')}</strong> to rival employers.</p>
    </section>`);
    parts.push(groupFold(true));
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
        ? html`<div class="panel stack offer-card" role="alertdialog" aria-labelledby="ref-confirm-title">
            <h3 id="ref-confirm-title">Send this referral?</h3>
            <p class="instruction">Employer ${me.label} recommends <strong>${pick.label}, ${pick.name}</strong> to Employer ${to}. Candidate score: <strong>${pick.score}</strong>.</p>
            <p class="small muted">Referrals cannot be edited or withdrawn.</p>
            <div class="btn-row">
              <button class="btn btn-secondary" data-act="ref-cancel" data-key="ref-cancel">Back</button>
              <button class="btn btn-primary" data-act="ref-send" data-key="ref-send" ${disabled(S.busy)}>Send referral</button>
            </div>
          </div>`
        : html`<form class="panel stack" data-form="referral" novalidate>
            <h2>Send a referral</h2>
            <fieldset class="choices">
              <legend>Who are you recommending?</legend>
              ${available.map((g) => html`<label class="choice"><input type="radio" name="refEmployee" value="${g.label}" data-bind="refEmployee" ${g.label === S.ui.refEmployee ? new Raw('checked') : ''}>
                <span><span class="chip">${g.label}</span><span class="grow">${g.name}</span><span class="score">${g.score}</span></span></label>`)}
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
      <div class="spread"><h2>Referrals</h2><span class="count">${sent} of ${H} sent</span></div>
      ${left > 0 ? html`<p class="muted">Send ${plural(left, 'more referral')}. Each must be a different person from your group. The app shows their true score.</p>` : html`<div class="notice notice-ok">${H === 1 ? 'Your referral is sent.' : `All ${H} referrals sent.`}</div>`}
      ${form}
    </section>`);
    parts.push(fold('sent', 'Referrals you sent', `${sent}`, sentList, sent > 0 && left === 0));
    parts.push(fold('received', 'Referrals you received', `${x.referralsReceived.length}`, receivedList, x.referralsReceived.length > 0));
    parts.push(groupFold(false));
    if (left === 0) parts.push(wait('Waiting for the host to open hiring.'));
  }

  if (d.phase === 'hiring') {
    const pending = x.offers.filter((o) => o.status === 'pending');
    const free = H - x.slotsUsed;
    parts.push(html`<section class="stack">
      <div class="spread"><h2>Your positions</h2><span class="count">${x.hired.length} of ${H} filled</span></div>
      ${x.hired.length ? html`<ul class="list panel">${x.hired.map((h) => html`<li><span class="chip">${h.label}</span><span class="grow"><span class="name">${h.name}</span><span class="tagline"><span class="tag tag-ok">Hired</span></span></span>${h.score == null ? html`<span class="score-unknown">Awaiting reveal</span>` : scoreBadge(h.score)}</li>`)}</ul>` : ''}
      ${pending.length ? html`<ul class="list panel">${pending.map((o) => html`<li><span class="chip">${o.label}</span><span class="grow"><span class="name">${o.name}</span><span class="tagline"><span class="tag tag-warn">Offer pending</span></span></span>
        <button class="btn btn-secondary btn-small" data-act="withdraw" data-id="${o.id}" data-key="wd-${o.id}" ${disabled(S.busy)}>Withdraw</button></li>`)}</ul>` : ''}
      ${free > 0 ? html`<p class="muted">${plural(free, 'open position')}. A pending offer holds a position until the employee answers.</p>` : x.hired.length === H ? html`<div class="notice notice-ok">All positions filled.</div>` : ''}
    </section>`);
    const cands = x.candidates.filter((c) => !c.hiredByMe);
    parts.push(html`<section class="stack">
      <h2>Candidates</h2>
      <ul class="list panel">${cands.map((c) => {
        const tags = [];
        if (c.referredBy) tags.push(html`<span class="tag tag-accent">Referred by ${c.referredBy}</span>`);
        if (c.pendingOffer) tags.push(html`<span class="tag tag-warn">Your offer is pending</span>`);
        if (c.hired) tags.push(html`<span class="tag">Hired elsewhere</span>`);
        const canOffer = !c.hired && !c.pendingOffer && free > 0;
        return html`<li><span class="chip">${c.label}</span><span class="grow"><span class="name">${c.name}</span>${tags.length ? html`<span class="tagline">${tags}</span>` : ''}</span>
          ${c.hired ? '' : html`<span class="stack tight end">${scoreBadge(c.knownScore)}
          <button class="btn btn-primary btn-small" data-act="offer" data-employee="${c.label}" data-key="offer-${c.label}" ${disabled(!canOffer || S.busy)}>Offer job</button></span>`}</li>`;
      })}</ul>
      <p class="small muted">Your own group is not listed. Without a referral, a score is a guess.</p>
    </section>`);
    const past = x.offers.filter((o) => o.status !== 'pending');
    if (past.length) {
      const label = { declined: 'Declined', withdrawn: 'Withdrawn', closed: 'Took another job', expired: 'Expired' };
      parts.push(fold('past-offers', 'Earlier offers', `${past.length}`, html`<ul class="list">${past.map((o) => html`<li><span class="chip">${o.label}</span><span class="grow name">${o.name}</span><span class="tag">${label[o.status]}</span></li>`)}</ul>`));
    }
    parts.push(fold('received', 'Referrals you received', `${x.referralsReceived.length}`, receivedList));
    parts.push(groupFold(false));
  }

  if (atLeast('results')) {
    parts.push(html`<section class="panel stack" aria-label="Your result">
      <div class="spread"><h2>Your total</h2><span class="big-score">${x.myTotal}</span></div>
      ${x.hired.length ? html`<ul class="list">${x.hired.map((h) => html`<li><span class="chip">${h.label}</span><span class="grow name">${h.name}</span>${scoreBadge(h.score)}</li>`)}</ul>` : html`<p class="muted">You did not hire anyone. Empty positions score zero.</p>`}
    </section>`);
    if (d.phase === 'discussion') parts.push(discussionBlock());
    parts.push(resultsBlock());
    parts.push(fold('sent', 'Referrals you sent', `${x.referralsSent.length}`, sentList));
    parts.push(fold('received', 'Referrals you received', `${x.referralsReceived.length}`, receivedList));
  }
  return parts;
}

function employeeHome() {
  const d = S.data; const me = d.me; const x = d.employee;
  const g = x.groupEmployer;
  const revealedCard = d.phase !== 'reveal' || storage.get(`rr_seen_${d.code}_${d.round}`) === true;
  const parts = [idCard(me, 'Goal: get hired.')];
  if (!revealedCard) { parts.push(wait('Tap the card to see your role.')); return parts; }

  const knows = html`<section class="panel stack">
    <p class="instruction"><strong>Employer ${g.label}</strong>${g.name ? ` (${g.name})` : ''} knows your score.</p>
    <p class="muted">Employer ${g.label} cannot hire you, but can refer you to Employer ${others(g.label).join(' or ')}. You do not know your own score.</p>
  </section>`;
  const referralStatus = x.referrals.length
    ? html`<ul class="list">${x.referrals.map((r) => html`<li><span class="chip">${r.from}</span><span class="grow">Employer ${r.from} referred you to <strong>Employer ${r.to}</strong>.</span></li>`)}</ul>`
    : html`<p class="muted">No one has referred you yet.</p>`;

  if (d.phase === 'reveal') {
    parts.push(knows);
    parts.push(wait('Waiting for the host to open networking.'));
  }
  if (d.phase === 'networking') {
    parts.push(html`<section class="panel stack"><h2>Referrals</h2>${referralStatus}<p class="small muted">Referrals never show you your score.</p></section>`);
    parts.push(knows);
    parts.push(wait('Hiring opens when the host is ready.'));
  }
  if (d.phase === 'hiring') {
    if (x.job) {
      parts.push(html`<section class="panel stack offer-card"><p class="muted">You're hired</p><p class="from">Employer ${x.job}</p><p>${employerName(x.job)}. This is final.</p></section>`);
      parts.push(wait('Waiting for the host to close hiring.'));
    } else {
      const pending = x.offers.filter((o) => o.status === 'pending');
      if (!pending.length) {
        parts.push(html`<section class="stack"><h2>Job offers</h2>${wait(`No offers yet. Talk to Employer ${others(g.label).join(' and Employer ')}.`)}</section>`);
      } else {
        parts.push(html`<section class="stack"><h2>Job offers</h2>${pending.map((o) => S.ui.confirmAccept === o.id
          ? html`<div class="panel stack offer-card" role="alertdialog" aria-labelledby="acc-${o.id}">
              <h3 id="acc-${o.id}">Accept Employer ${o.from}?</h3>
              <p>Accepting is final. Your other offers will close.</p>
              <div class="btn-row">
                <button class="btn btn-secondary" data-act="accept-cancel" data-key="acc-cancel">Back</button>
                <button class="btn btn-primary" data-act="accept" data-id="${o.id}" data-key="acc-yes-${o.id}" ${disabled(S.busy)}>Accept job</button>
              </div></div>`
          : html`<div class="panel stack offer-card">
              <p class="muted">Offer from</p><p class="from">Employer ${o.from}</p><p>${employerName(o.from)}</p>
              <div class="btn-row">
                <button class="btn btn-secondary" data-act="decline" data-id="${o.id}" data-key="dec-${o.id}" ${disabled(S.busy)}>Decline</button>
                <button class="btn btn-primary" data-act="accept-ask" data-id="${o.id}" data-key="acc-${o.id}" ${disabled(S.busy)}>Accept</button>
              </div></div>`)}</section>`);
      }
    }
    const past = x.offers.filter((o) => o.status !== 'pending');
    if (past.length) {
      const label = { declined: 'You declined', withdrawn: 'Withdrawn', closed: 'Closed', expired: 'Expired' };
      parts.push(fold('past-offers', 'Earlier offers', `${past.length}`, html`<ul class="list">${past.map((o) => html`<li><span class="chip">${o.from}</span><span class="grow">Employer ${o.from}</span><span class="tag">${label[o.status]}</span></li>`)}</ul>`));
    }
    parts.push(fold('refs', 'Referral status', `${x.referrals.length}`, referralStatus));
  }
  if (atLeast('results')) {
    parts.push(html`<section class="panel stack" aria-label="Your result">
      <div class="spread"><h2>Your score</h2><span class="big-score">${x.score}</span></div>
      ${x.job ? html`<div class="notice notice-ok">Hired by Employer ${x.job}. You reached your goal.</div>` : html`<div class="notice notice-warn">Not hired this round.</div>`}
    </section>`);
    if (d.phase === 'discussion') parts.push(discussionBlock());
    parts.push(resultsBlock());
    parts.push(fold('refs', 'Referral status', `${x.referrals.length}`, referralStatus));
  }
  return parts;
}

function spectatorHome() {
  const d = S.data;
  const parts = [html`<section class="stack"><h1>You're watching</h1>
    <p class="muted">You joined after roles were assigned, so you see public updates only. The host can add you as a player after a reset.</p></section>`];
  if (d.phase === 'discussion') parts.push(discussionBlock());
  if (d.results) parts.push(resultsBlock());
  else parts.push(wait(`${d.phaseName} is under way. Waiting for the host.`));
  parts.push(rosterFold());
  return parts;
}

function playerView() {
  const d = S.data;
  if (d.viewer === 'none') return joinView();
  const head = html`<section class="stack tight">
    <p class="instruction">${phaseInstruction()}</p>
  </section>`;
  let body;
  if (d.viewer === 'spectator') body = spectatorHome();
  else if (!d.me.role) {
    body = [html`<section class="stack"><h1>You're in, ${d.me.name}</h1>${wait('Waiting for the host to assign roles.')}</section>`,
      html`<section class="stack"><div class="spread"><h2>In the room</h2><span class="count">${d.setup.players}</span></div>
        <ul class="names">${d.lobby.names.map((n) => html`<li>${n}</li>`)}</ul></section>`,
      html`<section class="stack">${setupBox(d.setup)}</section>`];
  } else if (d.me.role === 'employer') body = employerHome();
  else body = employeeHome();
  return html`<div class="stack-lg">${d.me?.role ? head : ''}${body}${d.me?.role && d.phase !== 'reveal' ? rosterFold() : ''}</div>`;
}

// ---------- host ----------
function hostView() {
  const d = S.data; const h = d.host;
  const idx = phaseOrder.indexOf(d.phase);
  const side = html`<div class="host-side stack">
    <section class="panel stack centered">
      <p class="muted">Room code</p>
      <p class="room-code">${d.code}</p>
      <img class="qr" src="/api/rooms/${d.code}/qr.svg?v=${d.round}" alt="QR code to join room ${d.code}">
      <p class="join-url">${h.joinUrl.replace(/^https?:\/\//, '')}</p>
      <button class="btn btn-secondary btn-small" data-act="copy" data-text="${h.joinUrl}" data-key="copy-join">Copy join link</button>
    </section>
    ${/\/\/(localhost|127\.0\.0\.1)/.test(h.joinUrl) ? html`<div class="notice notice-warn">Phones cannot open "localhost". Start the server on a network address and open this page from it.</div>` : ''}
    ${fold('hostlink', 'Run the game from another device', null, html`<div class="stack">
      <p class="small muted">Anyone with this private link can control the game. Do not show it on the projector.</p>
      <button class="btn btn-secondary btn-small" data-act="copy" data-text="${h.hostUrl}" data-key="copy-host">Copy private host link</button>
    </div>`)}
  </div>`;

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
      <div class="spread"><h2>Attendance</h2><span class="count">${plural(players.length, 'player')}</span></div>
      ${setupBox(d.setup)}
    </section>`);
    afterPrimary.push(players.length
      ? html`<section class="stack"><h2>In the room</h2><ul class="list panel">${players.map((m) => html`<li><span class="grow name">${m.name}</span>
        <button class="btn btn-secondary btn-small" data-act="remove" data-id="${m.id}" data-key="rm-${m.id}" aria-label="Remove ${m.name}" ${disabled(S.busy)}>Remove</button></li>`)}</ul></section>`
      : wait('Waiting for players to join.'));
  } else {
    phaseBody.push(html`<p class="small muted">${plural(players.length, 'player')}: 3 employers and ${d.setup.employees} employees. Each employer hires ${d.setup.hires} and gives ${plural(d.setup.hires, 'referral')}.</p>`);
  }

  if (d.phase === 'reveal') {
    phaseBody.push(html`<div class="notice notice-accent">Players are reading their roles. Open networking when everyone is ready.</div>`);
  }
  if (d.phase === 'networking') {
    phaseBody.push(html`<section class="panel stack"><h2>Referrals</h2><div class="progress-rows">
      ${h.progress.map((p) => html`<div class="progress-row"><span class="chip">${p.employer}</span>
        <span class="bar" aria-hidden="true"><i data-pct="${Math.round((p.referralsSent / d.setup.hires) * 100)}"></i></span>
        <span class="count">${p.referralsSent} of ${d.setup.hires} ${p.referralsSent >= d.setup.hires ? '(done)' : ''}</span></div>`)}
    </div></section>`);
  }
  if (d.phase === 'hiring') {
    const pending = h.offers.filter((o) => o.status === 'pending');
    phaseBody.push(html`<section class="panel stack"><h2>Positions filled</h2><div class="progress-rows">
      ${h.progress.map((p) => html`<div class="progress-row"><span class="chip">${p.employer}</span>
        <span class="bar" aria-hidden="true"><i data-pct="${Math.round((p.filled / d.setup.hires) * 100)}"></i></span>
        <span class="count">${p.filled} of ${d.setup.hires}${p.pending ? `, ${p.pending} pending` : ''}</span></div>`)}
    </div></section>`);
    afterPrimary.push(fold('pending', 'Outstanding offers', `${pending.length}`, pending.length
      ? html`<ul class="list">${pending.map((o) => html`<li><span class="chip">${o.employer}</span><span class="grow">to <strong>${o.label}</strong> ${o.name}</span><span class="tag tag-warn">Pending</span></li>`)}</ul>`
      : html`<p class="muted">No offers waiting for an answer.</p>`, pending.length > 0));
  }
  if (atLeast('results')) {
    if (d.phase === 'discussion') phaseBody.push(discussionBlock());
    phaseBody.push(resultsBlock());
  }

  // Primary transition, with a warning step when things are unfinished.
  let primary = '';
  // Show the live warnings, so the panel updates if players finish while the host is deciding.
  const confirm = S.ui.confirmAdvance && S.ui.confirmAdvance.from === d.phase ? { ...S.ui.confirmAdvance, warnings: h.warnings } : null;
  if (nextLabel) {
    primary = confirm
      ? html`<div class="panel stack offer-card" role="alertdialog" aria-labelledby="adv-title">
          <h3 id="adv-title">${confirm.warnings.length ? 'Some steps are unfinished' : `${nextLabel}?`}</h3>
          ${confirm.warnings.length ? html`<ul class="stack tight bullets">${confirm.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
          ${d.phase === 'hiring' ? html`<p class="muted">Pending offers will expire and the results will be revealed to everyone. This cannot be undone.</p>` : html`<p class="muted">You can stay in ${d.phaseName.toLowerCase()} or continue anyway.</p>`}
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
    <p class="small muted">Do not project this section.</p>
    ${['A', 'B', 'C'].map((e) => {
      const emp = h.members.find((m) => m.role === 'employer' && m.label === e);
      const group = h.members.filter((m) => m.role === 'employee' && m.group === e).sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
      return html`<div><div class="spread"><h3>Employer ${e}: ${emp?.name}</h3>${h.preview ? html`<span class="count">${h.preview.totals.find((t) => t.employer === e).total} pts</span>` : ''}</div>
        <ul class="list">${group.map((m) => html`<li><span class="chip">${m.label}</span><span class="grow"><span class="name">${m.name}</span>${m.hiredBy ? html`<span class="tagline"><span class="tag tag-ok">Hired by ${m.hiredBy}</span></span>` : ''}</span>${scoreBadge(m.score)}</li>`)}</ul></div>`;
    })}
    ${h.referrals.length ? html`<div><h3>Referrals</h3><ul class="list">${h.referrals.map((r) => html`<li><span class="chip">${r.from}</span><span class="grow">${r.label} ${r.name} to Employer ${r.to}</span>${scoreBadge(r.score)}</li>`)}</ul></div>` : ''}
    ${h.preview && !atLeast('results') ? html`<p class="small muted">Current totals preview: ${h.preview.totals.map((t) => `${t.employer} ${t.total}`).join(', ')}. Players cannot see this.</p>` : ''}
  </div>`);

  const people = fold('people', 'Players and rejoin codes', plural(h.members.length, 'person', 'people'), html`<div class="stack">
    <p class="small muted">If someone switches phones or browsers, give them a rejoin code. It works once and expires in 15 minutes.</p>
    <ul class="list">${h.members.map((m) => html`<li><span class="grow"><span class="name">${m.name}</span>
      <span class="tagline">${m.spectator ? html`<span class="tag">Spectator</span>` : m.label ? html`<span class="tag">${m.role === 'employer' ? 'Employer' : 'Employee'} ${m.label}</span>` : ''}
      ${S.ui.rejoin[m.id] ? html`<span class="tag tag-accent">Code: ${S.ui.rejoin[m.id]}</span>` : ''}</span></span>
      <span class="row tight">
      <button class="btn btn-secondary btn-small" data-act="rejoin" data-id="${m.id}" data-key="rj-${m.id}" ${disabled(S.busy)}>Rejoin code</button>
      ${m.spectator || d.phase === 'lobby' ? html`<button class="btn btn-secondary btn-small" data-act="remove" data-id="${m.id}" data-key="rmx-${m.id}" aria-label="Remove ${m.name}" ${disabled(S.busy)}>Remove</button>` : ''}
      </span></li>`)}</ul>
    ${spectators.length && d.phase !== 'lobby' ? html`<p class="small muted">${plural(spectators.length, 'spectator')} will become players after a reset.</p>` : ''}
  </div>`);

  const resetPanel = fold('reset', d.phase === 'discussion' ? 'Play again' : 'Reset game', null, S.ui.confirmReset
    ? html`<div class="stack"><p><strong>Reset the game?</strong> Roles, referrals, offers and results will be erased. Everyone goes back to the lobby, and spectators become players.</p>
        <div class="btn-row"><button class="btn btn-secondary" data-act="reset-cancel" data-key="reset-cancel">Keep playing</button>
        <button class="btn btn-danger" data-act="reset-confirm" data-key="reset-confirm" ${disabled(S.busy)}>Reset everything</button></div></div>`
    : html`<div class="stack"><p class="muted">Start over with everyone currently in the room.</p>
        <button class="btn btn-danger" data-act="reset-ask" data-key="reset-ask">Reset game…</button></div>`, d.phase === 'discussion');

  return html`${side}<div class="stack-lg">
    <section class="stack tight">
      <ol class="stepper" aria-label="Phase ${idx + 1} of 6">${phaseOrder.map((p, i) => html`<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}"></li>`)}</ol>
      <h1>${d.phaseName}</h1>
    </section>
    ${phaseBody}
    ${primary}
    ${afterPrimary}
    ${priv}
    ${people}
    ${resetPanel}
  </div>`;
}

// ---------- rules ----------
function rulesView() {
  const s = S.data?.setup;
  const H = s?.ready ? s.hires : null;
  const n = (word) => (H ? plural(H, word) : `the room's number of ${word}s`);
  return html`<div class="stack-lg rules">
    <section class="stack">
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
      <h2>Secrets</h2>
      <ul>
        <li>There are three employers: A, B and C. Everyone else is an employee.</li>
        <li>Every employee has a secret score from 1 to 10. Employees do not know their own score.</li>
        <li>Each employer knows the scores of one group of employees, and <strong>cannot hire anyone in that group</strong>.</li>
      </ul>
    </section>
    <section class="stack">
      <h2>How it goes</h2>
      <ol>
        <li><strong>Role reveal.</strong> Tap your card to see your role.</li>
        <li><strong>Networking.</strong> Each employer must send ${n('referral')}, each about a different person in their group, to either rival employer. A referral shows the person's true score and cannot be changed or taken back.</li>
        <li><strong>Hiring.</strong> Each employer fills ${n('position')}. Employers make offers; employees accept or decline. A pending offer holds a position. Accepting is final.</li>
        <li><strong>Results.</strong> An employer's score is the total of their hires' scores. Empty positions score zero. Highest total wins; ties share the win.</li>
        <li><strong>Discussion.</strong> Talk about what happened.</li>
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
    <button class="btn btn-primary" data-nav="home" data-key="rules-back">Back to ${S.route.page === 'landing' ? 'home' : 'the game'}</button>
  </div>`;
}

// ---------- render ----------
function errorView() {
  const e = S.loadError;
  return html`<div class="stack-lg">
    <h1>${e.kind === 'missing' ? 'Room not found' : e.kind === 'host' ? 'Host access needed' : 'Something went wrong'}</h1>
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
  else if (!S.data) out = html`<p class="muted center-pad">Loading…</p>`;
  else if (page === 'host') out = hostView();
  else out = playerView();
  const str = String(out);

  $main.classList.toggle('host-layout', page === 'host' && S.tab === 'home' && !!S.data && !S.loadError);
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
    ? html`<span class="room-chip" aria-label="Room ${d.code}">${d.code}</span><span class="phase-pill">${d.phaseName}</span>`
    : '');
  for (const t of document.querySelectorAll('.tab')) {
    if (t.dataset.nav === S.tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  const labelHome = document.querySelector('.tab[data-nav="home"] span');
  if (labelHome) labelHome.textContent = 'Home';
  document.title = page === 'landing' ? 'The Referral Rush' : `${S.tab === 'rules' ? 'Rules' : page === 'host' ? 'Host' : 'Play'} · ${S.route.code} · The Referral Rush`;
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
      const k = `rr_seen_${S.data.code}_${S.data.round}`;
      storage.set(k, storage.get(k) !== true);
      render();
      break;
    }
    case 'ref-cancel': S.ui.confirmRef = false; render(); break;
    case 'ref-send': {
      const r = await playerAct('referral', { employee: S.ui.refEmployee, to: S.ui.refTo });
      S.ui.confirmRef = false;
      if (r?.ok) { S.ui.refEmployee = ''; }
      render();
      break;
    }
    case 'offer': playerAct('offer', { employee: el.dataset.employee }); break;
    case 'withdraw': playerAct('withdraw', { offerId: id }); break;
    case 'accept-ask': S.ui.confirmAccept = id; render(); break;
    case 'accept-cancel': S.ui.confirmAccept = ''; render(); break;
    case 'accept': await playerAct('accept', { offerId: id }); S.ui.confirmAccept = ''; render(); break;
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
