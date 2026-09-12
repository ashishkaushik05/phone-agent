// hermes-core dashboard.
//
// Connection model: ONE websocket (`/dashboard?token=...`) is the source of truth for live
// state. On (re)connect we do one full resync (calls + personas + contacts + sms + health);
// after that, list/detail data is refreshed only in response to a WS event that actually
// concerns it — never on a blind timer. The one exception is the device registry (connect/
// disconnect isn't pushed over the bus yet), which polls /health every 5s as a backstop.
// Reconnects use exponential backoff with jitter, and repeated instant-close handshakes are
// treated as a bad token rather than retried forever silently.

const $ = (s, root) => (root || document).querySelector(s);
const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function relTime(ms) {
  if (ms == null) return "";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return sec + "s ago";
  const min = Math.round(sec / 60);
  if (min < 60) return min + "m ago";
  return Math.round(min / 60) + "h ago";
}

function relTimeIso(iso) {
  return iso ? relTime(Date.parse(iso)) : "";
}

/** Every persona's stored instruction has the shared HARD RULES block appended server-side
 *  (persona-rules.ts withHardRules) — hide it in the editor; the server re-appends on save. */
function stripHardRules(instruction) {
  return String(instruction ?? "").split(/\n\nHARD RULES \(never break/)[0];
}

/** Director injects are stored as the raw `<<DIRECTOR - act silently: ...>>` wire text —
 *  show just the guidance content. */
function stripDirectorWrap(text) {
  return String(text ?? "").replace(/^<<\s*DIRECTOR[^:]*:\s*/i, "").replace(/>>\s*$/, "");
}

const ICON = {
  send: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/></svg>',
  hangup: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h3l1.5 4.5-2 1.5c1 2.5 3 4.5 5.5 5.5l1.5-2L20 14v3a2 2 0 0 1-2 2C10.5 19 5 13.5 5 6a2 2 0 0 1 1-2z"/><line x1="3" y1="21" x2="21" y2="3"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="16" y1="16" x2="21" y2="21"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  phone: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h3l1.5 4.5-2 1.5c1 2.5 3 4.5 5.5 5.5l1.5-2L20 14v3a2 2 0 0 1-2 2C10.5 19 5 13.5 5 6a2 2 0 0 1 1-2z"/></svg>',
  warn: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><circle cx="12" cy="16.5" r=".5" fill="currentColor"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
};

const STATUS = {
  active: { color: "var(--ok)", pulse: true, badge: "badge-ok", label: "Active" },
  dialing: { color: "var(--warn)", pulse: true, badge: "badge-warn", label: "Dialing" },
  queued: { color: "var(--warn)", pulse: false, badge: "badge-warn", label: "Queued" },
  ended: { color: "var(--muted-2)", pulse: false, badge: "badge-muted", label: "Ended" },
};
const END_BADGE = {
  aborted_off_script: "badge-danger", error: "badge-danger", dial_timeout: "badge-danger",
  watchdog: "badge-warn", agent_ended: "badge-muted", far_party: "badge-muted", remote_hangup: "badge-muted",
};
const TRUST_BADGE = { admin: "badge-violet", known: "badge-info", stranger: "badge-muted" };

// ---------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------

const state = {
  tab: "calls",
  conn: "reconnecting",
  calls: [], selectedCallId: null, callDetail: null, callFilter: "", statusFilter: "all",
  injectDraft: "", injectFlash: false, endCallArmed: false,
  showNewCall: false, newCall: { to: "", personaId: "", script: "" }, newCallErr: "",
  personas: [], selectedPersonaId: null, personaDraft: null, personaFlash: false,
  contacts: [], showAddContact: false, newContactName: "", newContactPhone: "",
  sms: [], selectedThreadPeer: null, smsDraft: "",
  showNewSms: false, newSms: { to: "", body: "" }, newSmsErr: "",
  whatsapp: [], waStatus: { state: "unpaired" }, selectedWaPeer: null, waDraft: "",
  showNewWa: false, newWa: { to: "", body: "" }, newWaErr: "", waPairing: false,
  devices: [],
};

const getToken = () => localStorage.getItem("hermes_token") || "";
const setToken = (t) => localStorage.setItem("hermes_token", t);
const clearToken = () => localStorage.removeItem("hermes_token");

// ---------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------

async function api(path, opts) {
  const headers = Object.assign({ "content-type": "application/json" }, (opts && opts.headers) || {});
  if (opts && opts.auth !== false) headers.authorization = "Bearer " + getToken();
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
  if (!res.ok) throw Object.assign(new Error("request failed: " + res.status), { status: res.status });
  return res.status === 204 ? null : res.json();
}

async function fullRefresh() {
  try {
    const [calls, personas, contacts, sms, whatsapp, waStatus] = await Promise.all([
      api("/calls", { auth: false }),
      api("/personas", { auth: false }),
      api("/contacts", { auth: false }),
      api("/sms", { auth: false }),
      api("/whatsapp", { auth: false }),
      api("/whatsapp/status", { auth: false }),
    ]);
    state.calls = calls;
    state.personas = personas;
    state.contacts = contacts;
    state.sms = sms;
    state.whatsapp = whatsapp;
    state.waStatus = waStatus;
    if (state.selectedCallId && calls.some((c) => c.id === state.selectedCallId)) {
      await refreshCallDetail();
    } else if (!state.selectedCallId && calls.length) {
      state.selectedCallId = calls[0].id;
      await refreshCallDetail();
    }
    if (!state.selectedPersonaId && personas.length) state.selectedPersonaId = personas[0].id;
    if (!state.selectedThreadPeer) state.selectedThreadPeer = threadPeers()[0] || null;
    if (!state.selectedWaPeer) state.selectedWaPeer = waThreadPeers()[0] || null;
    render();
  } catch (e) {
    if (e.status !== 401) console.error("[dashboard] full refresh failed:", e);
  }
}

async function refreshCallsList() {
  try {
    state.calls = await api("/calls", { auth: false });
    render();
  } catch (e) { console.error("[dashboard] refresh calls failed:", e); }
}

async function refreshSms() {
  try {
    state.sms = await api("/sms", { auth: false });
    render();
  } catch (e) { console.error("[dashboard] refresh sms failed:", e); }
}

/** One event ("kind":"whatsapp") covers both a new/updated message and a pairing state
 *  change — WhatsappClient's onChange doesn't distinguish, so just refetch both. */
async function refreshWhatsapp() {
  try {
    const [whatsapp, waStatus] = await Promise.all([
      api("/whatsapp", { auth: false }),
      api("/whatsapp/status", { auth: false }),
    ]);
    state.whatsapp = whatsapp;
    state.waStatus = waStatus;
    render();
  } catch (e) { console.error("[dashboard] refresh whatsapp failed:", e); }
}

async function refreshCallDetail() {
  if (!state.selectedCallId) { state.callDetail = null; return; }
  try {
    state.callDetail = await api(`/calls/${state.selectedCallId}`, { auth: false });
  } catch (e) { console.error("[dashboard] refresh call detail failed:", e); }
}

async function refreshDevices() {
  try {
    const h = await api("/health", { auth: false });
    state.devices = h.devices || [];
    renderTopBar();
    if (state.tab === "devices") renderContent();
  } catch (e) { /* transient — keep the last known set */ }
}

// ---------------------------------------------------------------------------------------
// websocket (live feed) — exponential backoff, bad-token detection
// ---------------------------------------------------------------------------------------

let ws = null;
let reconnectTimer = null;
let backoffMs = 1000;
const BACKOFF_MAX = 15000;
let hadOpenedThisAttempt = false;
let noOpenStreak = 0; // consecutive attempts that closed without ever opening (bad token / server down)
let openedSinceBoot = false;
let reachedMaxBackoff = false;

function setConn(next) {
  state.conn = next;
  renderConnUi();
}

/** Tear down any socket + pending reconnect. Safe to call repeatedly. */
function teardownWs() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch {}
    ws = null;
  }
}

function connectWs() {
  const token = getToken();
  if (!token) return;
  teardownWs(); // never run two sockets / two backoff chains at once
  hadOpenedThisAttempt = false;
  setConn(reachedMaxBackoff ? "offline" : "reconnecting");

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/dashboard?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    hadOpenedThisAttempt = true;
    openedSinceBoot = true;
    backoffMs = 1000;
    reachedMaxBackoff = false;
    noOpenStreak = 0;
    setConn("live");
    fullRefresh();
    refreshDevices();
  };

  ws.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.kind === "sms") return refreshSms();
    if (ev.kind === "whatsapp") return refreshWhatsapp();
    if (ev.kind === "status") refreshCallsList();
    if (ev.callId === state.selectedCallId) refreshCallDetail().then(render);
  };

  ws.onclose = () => {
    ws = null;
    if (hadOpenedThisAttempt) {
      noOpenStreak = 0;
    } else if (++noOpenStreak >= 3) {
      // 3 straight handshakes that never opened: almost always a bad token (server 401s the
      // upgrade), occasionally the server being down. Either way, spinning "Reconnecting"
      // forever is useless — send them to the gate with an actionable message.
      showGate(openedSinceBoot
        ? "Lost the connection and can't re-establish it — check the server, then reconnect."
        : "Couldn't connect. Check the control token is correct and hermes-core is running.");
      return;
    }
    setConn(reachedMaxBackoff ? "offline" : "reconnecting");
    const delay = backoffMs + Math.random() * 300;
    if (backoffMs >= BACKOFF_MAX) reachedMaxBackoff = true;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX);
    reconnectTimer = setTimeout(connectWs, delay);
  };

  ws.onerror = () => {};
}

// ---------------------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------------------

function showGate(err) {
  teardownWs();
  $("#shell").hidden = true;
  $("#gate").hidden = false;
  $("#gate-error").textContent = err || "";
  $("#gate-token").value = "";
  $("#gate-token").focus();
}

let devicesTimer = null;

function boot() {
  if (!getToken()) return showGate();
  $("#gate").hidden = true;
  $("#shell").hidden = false;
  backoffMs = 1000;
  reachedMaxBackoff = false;
  noOpenStreak = 0;
  openedSinceBoot = false;
  connectWs();
  refreshDevices();
  clearInterval(devicesTimer); // a re-boot (token re-entered) must not stack a 2nd poller
  devicesTimer = setInterval(refreshDevices, 5000); // device connect/disconnect isn't pushed over the bus yet
}

$("#gate-form").onsubmit = (e) => {
  e.preventDefault();
  const t = $("#gate-token").value.trim();
  if (!t) return;
  setToken(t);
  boot();
};

$("#btn-forget-token").onclick = () => {
  clearToken();
  showGate();
};

// ---------------------------------------------------------------------------------------
// top bar (connection pill / banner / device chips)
// ---------------------------------------------------------------------------------------

const CONN_UI = {
  live: { color: "var(--ok)", label: "Live", pulse: true },
  reconnecting: { color: "var(--warn)", label: "Reconnecting…", pulse: true },
  offline: { color: "var(--danger)", label: "Offline", pulse: false },
};

function renderConnUi() {
  const c = CONN_UI[state.conn] || CONN_UI.reconnecting;
  const dot = $("#conn-dot");
  dot.style.background = c.color;
  dot.style.color = c.color;
  dot.classList.toggle("pulse", c.pulse);
  $("#conn-label").textContent = c.label;
  $("#conn-label").style.color = c.color;

  const banner = $("#conn-banner");
  if (state.conn === "live") {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    banner.className = "conn-banner " + (state.conn === "offline" ? "danger" : "warn");
    banner.innerHTML = ICON.warn + " " + (state.conn === "offline"
      ? "Lost connection to hermes-core — live calls keep running on the phone, but this dashboard won't update until it reconnects."
      : "Reconnecting to hermes-core…");
  }
}

function renderTopBar() {
  $("#device-chips").innerHTML = state.devices.map((d) =>
    `<div class="device-chip"><span class="dot" style="background:var(--ok)"></span><span class="id">${escapeHtml(d.id)}</span><span class="meta">${escapeHtml(relTime(d.lastSeen))}</span></div>`
  ).join("") || `<div class="device-chip"><span class="meta">no devices connected</span></div>`;
  $("#nav-count-calls").textContent = state.calls.filter((c) => c.status !== "ended").length || "";
  $("#nav-count-devices").textContent = state.devices.length || "";
  $("#nav-count-whatsapp").textContent = state.waStatus.state === "connected" ? "" : "!";
}

// ---------------------------------------------------------------------------------------
// nav
// ---------------------------------------------------------------------------------------

$$(".nav-item[data-tab]").forEach((btn) => {
  btn.onclick = () => {
    state.tab = btn.dataset.tab;
    render();
  };
});

function render() {
  $$(".nav-item[data-tab]").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === state.tab));
  renderTopBar();
  renderConnUi();
  renderContent();
}

function renderContent() {
  const c = $("#content");
  if (state.tab === "calls") return renderCallsTab(c);
  if (state.tab === "personas") return renderPersonasTab(c);
  if (state.tab === "contacts") return renderContactsTab(c);
  if (state.tab === "sms") return renderSmsTab(c);
  if (state.tab === "whatsapp") return renderWhatsappTab(c);
  if (state.tab === "devices") return renderDevicesTab(c);
}

// ---------------------------------------------------------------------------------------
// calls tab
// ---------------------------------------------------------------------------------------

function filteredCalls() {
  return state.calls.filter((c) => {
    const live = c.status !== "ended";
    if (state.statusFilter === "live" && !live) return false;
    if (state.statusFilter === "ended" && live) return false;
    if (!state.callFilter.trim()) return true;
    const q = state.callFilter.toLowerCase();
    return (c.fromNumber || c.toNumber || "").toLowerCase().includes(q);
  });
}

function callBadge(c) {
  const st = STATUS[c.status] || STATUS.ended;
  if (c.status === "ended" && c.endReason) {
    return { cls: END_BADGE[c.endReason] || "badge-muted", label: c.endReason.replace(/_/g, " ") };
  }
  return { cls: st.badge, label: st.label };
}

function renderCallsTab(root) {
  const calls = filteredCalls();
  root.innerHTML = `
    <div class="call-list-col">
      <div class="col-head">
        <div class="col-title">
          <div><h2 style="display:inline">Calls</h2> <span class="sub">${state.calls.length} total</span></div>
          <button class="btn" id="btn-new-call" style="padding:5px 10px">${ICON.plus} New call</button>
        </div>
        <div class="search-box">${ICON.search}<input id="call-search" placeholder="Search a number…" value="${escapeHtml(state.callFilter)}" /></div>
        <div class="segmented">
          <button data-f="all" class="${state.statusFilter === "all" ? "active" : ""}">All</button>
          <button data-f="live" class="${state.statusFilter === "live" ? "active" : ""}">Live</button>
          <button data-f="ended" class="${state.statusFilter === "ended" ? "active" : ""}">Ended</button>
        </div>
      </div>
      ${state.showNewCall ? newCallFormHtml() : ""}
      <div class="call-rows" id="call-rows">
        ${calls.length ? calls.map(callRowHtml).join("") : `<div class="empty-state">No calls match this filter.</div>`}
      </div>
    </div>
    <div class="call-detail-col" id="call-detail-col"></div>
  `;

  $("#call-search").oninput = (e) => { state.callFilter = e.target.value; renderCallsTab(root); $("#call-search").focus(); $("#call-search").selectionStart = $("#call-search").value.length; };
  $$(".segmented button", root).forEach((b) => (b.onclick = () => { state.statusFilter = b.dataset.f; renderCallsTab(root); }));
  $$(".call-row", root).forEach((r) => (r.onclick = () => selectCall(r.dataset.id)));
  $("#btn-new-call").onclick = toggleNewCall;
  wireNewCallForm(root);

  renderCallDetail($("#call-detail-col"));
}

function toggleNewCall() {
  state.showNewCall = !state.showNewCall;
  state.newCallErr = "";
  if (state.showNewCall) {
    const def = state.personas.find((p) => p.isDefault) || state.personas[0];
    state.newCall = { to: "", personaId: def ? def.id : "", script: "" };
  }
  renderCallsTab($("#content"));
}

function newCallFormHtml() {
  const opts = state.personas
    .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === state.newCall.personaId ? "selected" : ""}>${escapeHtml(p.name)}${p.isDefault ? " (default)" : ""}</option>`)
    .join("");
  return `
    <div class="add-form" style="margin:10px 12px 4px">
      <label class="field-label" style="margin-bottom:2px">Place an outbound call</label>
      <input class="in" id="nc-to" placeholder="Number to call — E.164, e.g. +14155550142" value="${escapeHtml(state.newCall.to)}" />
      <select class="in" id="nc-persona">${opts || `<option value="">Default</option>`}</select>
      <textarea class="ta" id="nc-script" rows="3" placeholder="Script for this call (optional) — overrides / extends the persona…">${escapeHtml(state.newCall.script)}</textarea>
      ${state.newCallErr ? `<div class="gate-error" style="min-height:0">${escapeHtml(state.newCallErr)}</div>` : ""}
      <div class="add-form-actions">
        <button class="btn btn-primary" id="nc-submit">${ICON.send} Place call</button>
        <button class="btn btn-ghost" id="nc-cancel">Cancel</button>
      </div>
    </div>`;
}

function wireNewCallForm(root) {
  const to = $("#nc-to", root);
  if (!to) return;
  to.oninput = (e) => (state.newCall.to = e.target.value);
  $("#nc-persona", root).onchange = (e) => (state.newCall.personaId = e.target.value);
  $("#nc-script", root).oninput = (e) => (state.newCall.script = e.target.value);
  $("#nc-submit", root).onclick = placeCall;
  $("#nc-cancel", root).onclick = toggleNewCall;
}

async function placeCall() {
  const to = state.newCall.to.trim();
  if (!to) { state.newCallErr = "Enter a number to call."; renderCallsTab($("#content")); return; }
  const payload = { to };
  if (state.newCall.personaId) payload.persona_id = state.newCall.personaId;
  const script = state.newCall.script.trim();
  if (script) payload.script = script;
  try {
    const r = await api("/calls", { method: "POST", body: JSON.stringify(payload) });
    state.showNewCall = false;
    state.newCall = { to: "", personaId: "", script: "" };
    state.newCallErr = "";
    state.selectedCallId = r.call_id;
    await refreshCallsList();
    await refreshCallDetail();
    render();
  } catch (e) {
    if (e.status === 401) return showGate("Session token rejected — re-enter it to place a call.");
    if (e.status === 409) state.newCallErr = "No phone connected — or more than one, so hermes can't tell which to use.";
    else if (e.status === 404) state.newCallErr = "That persona no longer exists — pick another.";
    else state.newCallErr = "Couldn't place the call (" + e.message + ").";
    renderCallsTab($("#content"));
  }
}

function callRowHtml(c) {
  const st = STATUS[c.status] || STATUS.ended;
  const b = callBadge(c);
  const peer = c.fromNumber || c.toNumber || "unknown";
  return `
    <div class="call-row ${c.id === state.selectedCallId ? "selected" : ""}" data-id="${escapeHtml(c.id)}">
      <div class="call-row-top">
        <span class="dot ${st.pulse ? "pulse" : ""}" style="background:${st.color};color:${st.color}"></span>
        <span class="call-row-peer">${escapeHtml(peer)}</span>
        <span class="call-row-badge badge ${b.cls}">${escapeHtml(b.label)}</span>
      </div>
      <div class="call-row-meta">
        <span>${escapeHtml(c.deviceId || "—")}</span>
        <span class="sep">·</span>
        <span>${c.status === "ended" ? relTimeIso(c.endedAt) : relTimeIso(c.startedAt)}</span>
      </div>
    </div>`;
}

function selectCall(id) {
  state.selectedCallId = id;
  state.endCallArmed = false;
  refreshCallDetail().then(render);
}

function buildFeed(detail) {
  const lines = (detail.transcript || []).map((t) => ({ ts: Date.parse(t.ts), row: transcriptRowHtml(t) }));
  // An "inject" action's content is already shown as the director note in the transcript
  // (both are written at the same moment, see call-engine.ts maybeSteer / manualInject) —
  // only surface the other action kinds here so nothing appears twice.
  const actions = (detail.actions || [])
    .filter((a) => a.kind !== "inject")
    .map((a) => ({ ts: Date.parse(a.ts), row: actionRowHtml(a) }));
  return lines.concat(actions).sort((a, b) => a.ts - b.ts).map((x) => x.row).join("");
}

function transcriptRowHtml(t) {
  if (t.role === "director") {
    return `<div class="feed-note">${ICON.send}<span class="txt"><span class="lbl">director</span>${escapeHtml(stripDirectorWrap(t.text))}</span></div>`;
  }
  return `<div class="feed-line ${escapeHtml(t.role)}"><span class="who">${escapeHtml(t.role)}</span><span class="bubble">${escapeHtml(t.text)}</span></div>`;
}

function actionRowHtml(a) {
  if (a.kind === "hangup") {
    const reason = (a.payload && a.payload.reason) || a.matched || "";
    const danger = reason === "aborted_off_script" || reason === "error";
    return `<div class="feed-action ${danger ? "danger" : ""}">${ICON.hangup} call ended · ${escapeHtml(reason)}</div>`;
  }
  if (a.kind === "note") {
    const text = (a.payload && a.payload.note) || "";
    return `<div class="feed-action">${escapeHtml(a.category)} — ${escapeHtml(text)}</div>`;
  }
  return `<div class="feed-action">${escapeHtml(a.category)} · ${escapeHtml(a.kind)}</div>`;
}

function renderCallDetail(root) {
  const d = state.callDetail;
  if (!d || d.id !== state.selectedCallId) {
    root.innerHTML = `<div class="section-empty">${ICON.phone}<span>Select a call to see its transcript</span></div>`;
    return;
  }
  const b = callBadge(d);
  const isLive = d.status !== "ended";
  const peer = d.fromNumber || d.toNumber || "unknown";

  root.innerHTML = `
    <div class="detail-head">
      <div class="detail-head-top">
        <span class="detail-peer">${escapeHtml(peer)}</span>
        <span class="badge ${b.cls}">${escapeHtml(b.label)}</span>
        <div class="detail-actions">
          ${isLive ? `<button class="btn" id="btn-focus-inject">${ICON.send} Inject</button>` : ""}
          ${isLive ? `<button class="btn ${state.endCallArmed ? "btn-danger confirm" : "btn-danger"}" id="btn-end-call">${ICON.hangup} ${state.endCallArmed ? "Confirm end call" : "End call"}</button>` : ""}
        </div>
      </div>
      <div class="detail-meta-row">
        <span class="badge badge-muted mono">${escapeHtml(d.deviceId || "—")}</span>
        <span class="badge badge-muted">${escapeHtml(d.direction)}</span>
        <span style="color:var(--muted-2)">${isLive ? "started " + relTimeIso(d.startedAt) : "ended " + relTimeIso(d.endedAt)}</span>
      </div>
    </div>
    ${d.outcomeSummary ? `<div class="outcome-box"><span class="label">Outcome summary</span>${escapeHtml(d.outcomeSummary)}</div>` : ""}
    <div class="feed">${buildFeed(d) || `<div class="empty-state">No transcript yet.</div>`}</div>
    ${isLive ? `
      <div class="inject-bar">
        <div class="inject-row">
          <textarea class="inject-input" id="inject-input" placeholder="Send silent guidance to the agent — it won't be read aloud…">${escapeHtml(state.injectDraft)}</textarea>
          <button class="btn btn-primary" id="btn-send-inject">${ICON.send} Send</button>
        </div>
        <div class="inject-hint">${state.injectFlash ? `<span class="flash">✓ Delivered to the agent silently</span>` : `<span>Only the agent hears this. The caller never does.</span>`}</div>
      </div>` : ""}
  `;

  const feedEl = $(".feed", root);
  if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;

  if (isLive) {
    $("#inject-input").oninput = (e) => (state.injectDraft = e.target.value);
    $("#btn-focus-inject").onclick = () => $("#inject-input").focus();
    $("#btn-send-inject").onclick = sendInject;
    $("#btn-end-call").onclick = onEndCallClick;
  }
}

async function sendInject() {
  const text = state.injectDraft.trim();
  if (!text || !state.selectedCallId) return;
  try {
    await api(`/calls/${state.selectedCallId}/inject`, { method: "POST", body: JSON.stringify({ text }) });
    state.injectDraft = "";
    state.injectFlash = true;
    await refreshCallDetail();
    render();
    setTimeout(() => { state.injectFlash = false; render(); }, 1800);
  } catch (e) {
    if (e.status === 401) showGate("Session token rejected — re-enter it to send guidance.");
    else alert("Inject failed — is a phone connected for this call? (" + e.message + ")");
  }
}

async function onEndCallClick() {
  if (!state.endCallArmed) { state.endCallArmed = true; render(); return; }
  state.endCallArmed = false;
  try {
    await api(`/calls/${state.selectedCallId}/hangup`, { method: "POST" });
  } catch (e) {
    if (e.status === 401) showGate("Session token rejected — re-enter it to end calls.");
    else alert("Hangup failed: " + e.message);
  }
  render();
}

// ---------------------------------------------------------------------------------------
// personas tab
// ---------------------------------------------------------------------------------------

function currentPersona() {
  return state.personas.find((p) => p.id === state.selectedPersonaId) || null;
}

function ensurePersonaDraft() {
  const p = currentPersona();
  if (!p) { state.personaDraft = null; return null; }
  if (!state.personaDraft || state.personaDraft.id !== p.id) {
    state.personaDraft = {
      id: p.id,
      instruction: stripHardRules(p.systemInstruction),
      needsData: (p.triggerConfig.needsData || []).join(", "),
      escalation: (p.triggerConfig.escalation || []).join(", "),
      offScript: (p.triggerConfig.offScript || []).join(", "),
      closing: (p.triggerConfig.closing || []).join(", "),
    };
  }
  return state.personaDraft;
}

function renderPersonasTab(root) {
  const p = currentPersona();
  const draft = ensurePersonaDraft();
  root.innerHTML = `
    <div class="pane-list">
      <div class="col-head"><div class="col-title"><h2>Personas</h2><span class="sub">${state.personas.length}</span></div></div>
      <div class="call-rows">
        ${state.personas.map((x) => `
          <div class="list-row ${x.id === state.selectedPersonaId ? "selected" : ""}" data-id="${escapeHtml(x.id)}">
            <div class="list-row-top"><span class="list-row-title">${escapeHtml(x.name)}</span>${x.isDefault ? `<span class="badge badge-info">Default</span>` : ""}</div>
            <span class="list-row-sub mono">${escapeHtml(x.id)}</span>
          </div>`).join("")}
      </div>
      <div style="padding:10px"><button class="btn" id="btn-new-persona" style="width:100%;justify-content:center">${ICON.plus} New persona</button></div>
    </div>
    <div class="pane-detail" id="persona-detail"></div>
  `;
  $$(".list-row", root).forEach((r) => (r.onclick = () => { state.selectedPersonaId = r.dataset.id; state.personaDraft = null; state.personaFlash = false; render(); }));
  $("#btn-new-persona").onclick = createPersona;
  renderPersonaDetail($("#persona-detail"), p, draft);
}

function renderPersonaDetail(root, p, draft) {
  if (!p || !draft) { root.innerHTML = `<div class="section-empty">No personas yet.</div>`; return; }
  root.innerHTML = `
    <div class="detail-title-row"><h2>${escapeHtml(p.name)}</h2>${p.isDefault ? `<span class="badge badge-info">Default</span>` : ""}</div>
    <span class="list-row-sub mono" style="margin-bottom:20px;display:block">${escapeHtml(p.id)}</span>

    <div class="field-block">
      <span class="field-label">System instruction</span>
      <textarea class="ta" id="pf-instruction" rows="6">${escapeHtml(draft.instruction)}</textarea>
    </div>

    <div class="field-block">
      <span class="field-label">Trigger keywords (comma-separated)</span>
      <div class="cat-block"><div class="cat-label"><span class="badge badge-warn">needsData</span></div><input class="in" id="pf-needsData" value="${escapeHtml(draft.needsData)}" /></div>
      <div class="cat-block"><div class="cat-label"><span class="badge badge-violet">escalation</span></div><input class="in" id="pf-escalation" value="${escapeHtml(draft.escalation)}" /></div>
      <div class="cat-block"><div class="cat-label"><span class="badge badge-danger">offScript</span></div><input class="in" id="pf-offScript" value="${escapeHtml(draft.offScript)}" /></div>
      <div class="cat-block"><div class="cat-label"><span class="badge badge-muted">closing</span></div><input class="in" id="pf-closing" value="${escapeHtml(draft.closing)}" /></div>
    </div>

    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn btn-primary" id="btn-save-persona">Save persona</button>
      ${!p.isDefault ? `<button class="btn btn-danger" id="btn-delete-persona">Delete</button>` : ""}
      ${state.personaFlash ? `<span class="flash">✓ Saved</span>` : ""}
    </div>
  `;
  $("#pf-instruction").oninput = (e) => (draft.instruction = e.target.value);
  ["needsData", "escalation", "offScript", "closing"].forEach((k) => {
    $("#pf-" + k).oninput = (e) => (draft[k] = e.target.value);
  });
  $("#btn-save-persona").onclick = savePersona;
  const del = $("#btn-delete-persona");
  if (del) del.onclick = deletePersona;
}

function splitTags(s) { return s.split(",").map((x) => x.trim()).filter(Boolean); }

async function savePersona() {
  const p = currentPersona();
  const draft = state.personaDraft;
  if (!p || !draft) return;
  try {
    await api(`/personas/${p.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: p.name,
        systemInstruction: draft.instruction,
        triggerConfig: {
          needsData: splitTags(draft.needsData),
          escalation: splitTags(draft.escalation),
          offScript: splitTags(draft.offScript),
          closing: splitTags(draft.closing),
        },
        isDefault: p.isDefault,
      }),
    });
    state.personas = await api("/personas", { auth: false });
    state.personaDraft = null;
    state.personaFlash = true;
    render();
    setTimeout(() => { state.personaFlash = false; render(); }, 1600);
  } catch (e) {
    if (e.status === 401) showGate("Session token rejected — re-enter it to save.");
    else alert("Save failed: " + e.message);
  }
}

async function deletePersona() {
  const p = currentPersona();
  if (!p || !confirm(`Delete persona "${p.name}"?`)) return;
  try {
    await api(`/personas/${p.id}`, { method: "DELETE" });
    state.personas = await api("/personas", { auth: false });
    state.selectedPersonaId = state.personas[0] ? state.personas[0].id : null;
    state.personaDraft = null;
    render();
  } catch (e) {
    if (e.status === 401) showGate("Session token rejected — re-enter it to delete.");
    else alert("Delete failed: " + e.message);
  }
}

async function createPersona() {
  const id = prompt("Persona id (short, lowercase, e.g. after-hours):");
  if (!id) return;
  const name = prompt("Display name:", id) || id;
  try {
    await api("/personas", {
      method: "POST",
      body: JSON.stringify({ id, name, systemInstruction: "You are a phone receptionist.", triggerConfig: { needsData: [], escalation: [], offScript: [], closing: [] } }),
    });
    state.personas = await api("/personas", { auth: false });
    state.selectedPersonaId = id;
    state.personaDraft = null;
    render();
  } catch (e) {
    if (e.status === 401) showGate("Session token rejected — re-enter it to create a persona.");
    else alert("Create failed: " + e.message);
  }
}

// ---------------------------------------------------------------------------------------
// contacts tab
// ---------------------------------------------------------------------------------------

function renderContactsTab(root) {
  root.innerHTML = `
    <div class="section-full">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div><h2 style="margin:0;font-size:16px">Contacts</h2><span class="list-row-sub">${state.contacts.length} contacts</span></div>
        <button class="btn btn-primary" id="btn-toggle-add-contact">${ICON.plus} Add contact</button>
      </div>
      ${state.showAddContact ? `
        <div class="add-form">
          <input id="nc-name" placeholder="Name" value="${escapeHtml(state.newContactName)}" />
          <input id="nc-phone" placeholder="Phone (E.164, e.g. +14155550100)" value="${escapeHtml(state.newContactPhone)}" />
          <div class="add-form-actions">
            <button class="btn btn-primary" id="btn-submit-contact">Save</button>
            <button class="btn btn-ghost" id="btn-cancel-contact">Cancel</button>
          </div>
        </div>` : ""}
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr><th>Name</th><th>Phone</th><th>Trust</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            ${state.contacts.map((c) => `
              <tr>
                <td>${escapeHtml(c.name || "—")}</td>
                <td class="mono">${escapeHtml(c.phoneE164)}</td>
                <td><select class="trust-select" data-id="${escapeHtml(c.id)}">
                  ${["admin", "known", "stranger"].map((t) => `<option value="${t}" ${c.trustTier === t ? "selected" : ""}>${t}</option>`).join("")}
                </select></td>
                <td style="color:var(--muted)">${escapeHtml(c.notes || "")}</td>
                <td><button class="btn btn-ghost" data-del="${escapeHtml(c.id)}">Remove</button></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
  $("#btn-toggle-add-contact").onclick = () => { state.showAddContact = !state.showAddContact; state.newContactName = ""; state.newContactPhone = ""; render(); };
  const cancel = $("#btn-cancel-contact");
  if (cancel) cancel.onclick = () => { state.showAddContact = false; render(); };
  const nameEl = $("#nc-name");
  if (nameEl) { nameEl.oninput = (e) => (state.newContactName = e.target.value); $("#nc-phone").oninput = (e) => (state.newContactPhone = e.target.value); }
  const submit = $("#btn-submit-contact");
  if (submit) submit.onclick = submitAddContact;
  $$("select.trust-select", root).forEach((sel) => (sel.onchange = () => updateContactTrust(sel.dataset.id, sel.value)));
  $$("button[data-del]", root).forEach((b) => (b.onclick = () => removeContact(b.dataset.del)));
}

async function submitAddContact() {
  if (!state.newContactPhone.trim()) return;
  try {
    await api("/contacts", { method: "POST", body: JSON.stringify({ phoneE164: state.newContactPhone.trim(), name: state.newContactName.trim() || null }) });
    state.contacts = await api("/contacts", { auth: false });
    state.showAddContact = false;
    render();
  } catch (e) {
    if (e.status === 401) showGate("Session token rejected — re-enter it to add a contact.");
    else alert("Add contact failed: " + e.message);
  }
}

async function updateContactTrust(id, trustTier) {
  try {
    await api(`/contacts/${id}`, { method: "PUT", body: JSON.stringify({ trustTier }) });
    state.contacts = await api("/contacts", { auth: false });
    render();
  } catch (e) {
    if (e.status === 401) showGate("Session token rejected — re-enter it to edit a contact.");
    else alert("Update failed: " + e.message);
  }
}

async function removeContact(id) {
  if (!confirm("Remove this contact?")) return;
  try {
    await api(`/contacts/${id}`, { method: "DELETE" });
    state.contacts = await api("/contacts", { auth: false });
    render();
  } catch (e) {
    if (e.status === 401) showGate("Session token rejected — re-enter it to remove a contact.");
    else alert("Remove failed: " + e.message);
  }
}

// ---------------------------------------------------------------------------------------
// sms tab
// ---------------------------------------------------------------------------------------

/** Peers with a thread, most-recently-active first. */
function threadPeers() {
  const lastTs = new Map();
  for (const m of state.sms) lastTs.set(m.peer, Math.max(lastTs.get(m.peer) || 0, Date.parse(m.ts) || 0));
  return [...lastTs.keys()].sort((a, b) => lastTs.get(b) - lastTs.get(a));
}

function contactFor(peer) {
  return state.contacts.find((c) => c.phoneE164 === peer) || null;
}

function renderSmsTab(root) {
  const peers = threadPeers();
  if (!state.selectedThreadPeer || !peers.includes(state.selectedThreadPeer)) state.selectedThreadPeer = peers[0] || null;

  root.innerHTML = `
    <div class="pane-list">
      <div class="col-head">
        <div class="col-title">
          <div><h2 style="display:inline">SMS</h2> <span class="sub">${peers.length} threads</span></div>
          <button class="btn" id="btn-new-sms" style="padding:5px 10px">${ICON.plus} New</button>
        </div>
      </div>
      ${state.showNewSms ? newSmsFormHtml() : ""}
      <div class="call-rows">
        ${peers.length ? peers.map((peer) => {
          const msgs = state.sms.filter((m) => m.peer === peer);
          const last = msgs[msgs.length - 1];
          const c = contactFor(peer);
          return `<div class="list-row ${peer === state.selectedThreadPeer ? "selected" : ""}" data-peer="${escapeHtml(peer)}">
            <div class="list-row-top"><span class="list-row-title ${c && c.name ? "" : "mono"}">${escapeHtml(c && c.name ? c.name : peer)}</span></div>
            <span class="list-row-sub">${escapeHtml(last ? last.body : "")}</span>
          </div>`;
        }).join("") : `<div class="empty-state">No SMS yet.</div>`}
      </div>
    </div>
    <div class="thread-view" id="thread-view"></div>
  `;
  $$(".list-row", root).forEach((r) => (r.onclick = () => { state.selectedThreadPeer = r.dataset.peer; render(); }));
  $("#btn-new-sms").onclick = toggleNewSms;
  wireNewSmsForm(root);
  renderThread($("#thread-view"));
}

function toggleNewSms() {
  state.showNewSms = !state.showNewSms;
  state.newSmsErr = "";
  if (state.showNewSms) state.newSms = { to: "", body: "" };
  renderSmsTab($("#content"));
}

function newSmsFormHtml() {
  return `
    <div class="add-form" style="margin:10px 12px 4px">
      <label class="field-label" style="margin-bottom:2px">New message</label>
      <input class="in" id="ns-to" placeholder="Number — E.164, e.g. +14155550142" value="${escapeHtml(state.newSms.to)}" />
      <textarea class="ta" id="ns-body" rows="3" placeholder="Message…">${escapeHtml(state.newSms.body)}</textarea>
      ${state.newSmsErr ? `<div class="gate-error" style="min-height:0">${escapeHtml(state.newSmsErr)}</div>` : ""}
      <div class="add-form-actions">
        <button class="btn btn-primary" id="ns-send">${ICON.send} Send</button>
        <button class="btn btn-ghost" id="ns-cancel">Cancel</button>
      </div>
    </div>`;
}

function wireNewSmsForm(root) {
  const to = $("#ns-to", root);
  if (!to) return;
  to.oninput = (e) => (state.newSms.to = e.target.value);
  $("#ns-body", root).oninput = (e) => (state.newSms.body = e.target.value);
  $("#ns-send", root).onclick = sendNewSms;
  $("#ns-cancel", root).onclick = toggleNewSms;
}

async function sendNewSms() {
  const to = state.newSms.to.trim();
  const body = state.newSms.body.trim();
  if (!to || !body) { state.newSmsErr = "Number and message are both required."; return renderSmsTab($("#content")); }
  try {
    await api("/sms", { method: "POST", body: JSON.stringify({ to, body }) });
    state.showNewSms = false;
    state.newSms = { to: "", body: "" };
    state.newSmsErr = "";
    state.sms = await api("/sms", { auth: false });
    state.selectedThreadPeer = threadPeers()[0] || state.selectedThreadPeer;
    render();
  } catch (e) {
    if (e.status === 401) return showGate("Session token rejected — re-enter it to send SMS.");
    if (e.status === 409) state.newSmsErr = "No phone connected — or more than one, so hermes can't tell which to use.";
    else state.newSmsErr = "Couldn't send (" + e.message + ").";
    renderSmsTab($("#content"));
  }
}

const SMS_STATUS_GLYPH = { queued: "·", sent: "✓", delivered: "✓✓", failed: "⚠", received: "" };

function smsBubbleHtml(m) {
  const glyph = m.direction === "outbound" ? (SMS_STATUS_GLYPH[m.status] ?? "") : "";
  const cls = m.status === "failed" ? "sms-status failed" : "sms-status";
  const meta = glyph
    ? `<span class="${cls}" title="${escapeHtml(m.status + (m.error ? ": " + m.error : ""))}">${glyph}</span>`
    : "";
  return `<div class="sms-bubble ${escapeHtml(m.direction)}">${escapeHtml(m.body)}${meta}</div>`;
}

function renderThread(root) {
  const peer = state.selectedThreadPeer;
  if (!peer) { root.innerHTML = `<div class="section-empty">No conversations yet.</div>`; return; }
  const msgs = state.sms.filter((m) => m.peer === peer);
  const contact = state.contacts.find((c) => c.phoneE164 === peer);
  const title = contact && contact.name ? contact.name : peer;
  const trust = contact ? `<span class="badge ${TRUST_BADGE[contact.trustTier] || "badge-muted"}">${escapeHtml(contact.trustTier)}</span>` : "";
  root.innerHTML = `
    <div class="thread-head">
      <span class="detail-peer" style="font-size:14px">${escapeHtml(title)}</span>
      ${contact && contact.name ? `<span class="list-row-sub mono" style="margin-left:8px">${escapeHtml(peer)}</span>` : ""}
      ${trust}
    </div>
    <div class="thread-messages">${msgs.map(smsBubbleHtml).join("")}</div>
    <div class="sms-bar"><input class="in" id="sms-input" placeholder="Type a message…" value="${escapeHtml(state.smsDraft)}" /><button class="btn btn-primary" id="btn-send-sms">${ICON.send} Send</button></div>
  `;
  const box = $(".thread-messages", root);
  if (box) box.scrollTop = box.scrollHeight;
  $("#sms-input").oninput = (e) => (state.smsDraft = e.target.value);
  $("#btn-send-sms").onclick = sendSms;
}

async function sendSms() {
  const peer = state.selectedThreadPeer;
  const body = state.smsDraft.trim();
  if (!peer || !body) return;
  try {
    await api("/sms", { method: "POST", body: JSON.stringify({ to: peer, body }) });
    state.smsDraft = "";
    state.sms = await api("/sms", { auth: false });
    render();
  } catch (e) {
    if (e.status === 401) showGate("Session token rejected — re-enter it to send SMS.");
    else alert("Send failed — is a phone connected? (" + e.message + ")");
  }
}

// ---------------------------------------------------------------------------------------
// whatsapp tab — same thread-list/thread-view shape as sms (reuses its bubble/bar CSS),
// plus a pairing card up top whenever the account isn't connected (see spec's first-time-
// connect flow: unpaired -> qr-pending -> connected, with logged_out needing a re-pair).
// ---------------------------------------------------------------------------------------

function waThreadPeers() {
  const lastTs = new Map();
  for (const m of state.whatsapp) lastTs.set(m.peer, Math.max(lastTs.get(m.peer) || 0, Date.parse(m.ts) || 0));
  return [...lastTs.keys()].sort((a, b) => lastTs.get(b) - lastTs.get(a));
}

const WA_PAIR_COPY = {
  unpaired: "Not paired yet — click Pair device and scan the QR code with WhatsApp on the agent's phone (Settings → Linked devices → Link a device).",
  "qr-pending": "Scan this QR code with WhatsApp on the agent's phone (Settings → Linked devices → Link a device). It refreshes periodically if not scanned in time.",
  disconnected: "Reconnecting… no action needed — this clears on its own once the connection comes back.",
  logged_out: "The linked device was removed from WhatsApp (or the session expired). Click Pair device to link again.",
};

function waPairCardHtml() {
  const st = state.waStatus.state;
  if (st === "connected") return "";
  const showButton = st === "unpaired" || st === "logged_out";
  return `
    <div class="add-form wa-pair-card" style="margin:10px 12px 4px">
      <label class="field-label" style="margin-bottom:2px">WhatsApp — ${escapeHtml(st.replace("_", " "))}</label>
      <div class="list-row-sub">${WA_PAIR_COPY[st] || ""}</div>
      ${st === "qr-pending" && state.waStatus.qr ? `<img class="wa-qr" src="${state.waStatus.qr}" alt="WhatsApp pairing QR code" />` : ""}
      ${showButton ? `<div class="add-form-actions"><button class="btn btn-primary" id="btn-wa-pair" ${state.waPairing ? "disabled" : ""}>${state.waPairing ? "Pairing…" : "Pair device"}</button></div>` : ""}
    </div>`;
}

function wirePairButton(root) {
  const btn = $("#btn-wa-pair", root);
  if (!btn) return;
  btn.onclick = async () => {
    state.waPairing = true;
    renderWhatsappTab($("#content"));
    try {
      state.waStatus = await api("/whatsapp/pair", { method: "POST" });
    } catch (e) {
      if (e.status === 401) return showGate("Session token rejected — re-enter it to pair WhatsApp.");
      alert("Pairing failed (" + e.message + ")");
    } finally {
      state.waPairing = false;
      renderWhatsappTab($("#content"));
    }
  };
}

function renderWhatsappTab(root) {
  const peers = waThreadPeers();
  if (!state.selectedWaPeer || !peers.includes(state.selectedWaPeer)) state.selectedWaPeer = peers[0] || null;

  root.innerHTML = `
    <div class="pane-list">
      <div class="col-head">
        <div class="col-title">
          <div><h2 style="display:inline">WhatsApp</h2> <span class="sub">${peers.length} threads</span></div>
          <button class="btn" id="btn-new-wa" style="padding:5px 10px">${ICON.plus} New</button>
        </div>
      </div>
      ${waPairCardHtml()}
      ${state.showNewWa ? newWaFormHtml() : ""}
      <div class="call-rows">
        ${peers.length ? peers.map((peer) => {
          const msgs = state.whatsapp.filter((m) => m.peer === peer);
          const last = msgs[msgs.length - 1];
          const c = contactFor(peer);
          return `<div class="list-row ${peer === state.selectedWaPeer ? "selected" : ""}" data-peer="${escapeHtml(peer)}">
            <div class="list-row-top"><span class="list-row-title ${c && c.name ? "" : "mono"}">${escapeHtml(c && c.name ? c.name : peer)}</span></div>
            <span class="list-row-sub">${escapeHtml(last ? last.body : "")}</span>
          </div>`;
        }).join("") : `<div class="empty-state">No WhatsApp messages yet.</div>`}
      </div>
    </div>
    <div class="thread-view" id="wa-thread-view"></div>
  `;
  $$(".list-row", root).forEach((r) => (r.onclick = () => { state.selectedWaPeer = r.dataset.peer; render(); }));
  $("#btn-new-wa").onclick = toggleNewWa;
  wireNewWaForm(root);
  wirePairButton(root);
  renderWaThread($("#wa-thread-view"));
}

function toggleNewWa() {
  state.showNewWa = !state.showNewWa;
  state.newWaErr = "";
  if (state.showNewWa) state.newWa = { to: "", body: "" };
  renderWhatsappTab($("#content"));
}

function newWaFormHtml() {
  return `
    <div class="add-form" style="margin:10px 12px 4px">
      <label class="field-label" style="margin-bottom:2px">New message</label>
      <input class="in" id="nw-to" placeholder="Number — E.164, e.g. +14155550142" value="${escapeHtml(state.newWa.to)}" />
      <textarea class="ta" id="nw-body" rows="3" placeholder="Message…">${escapeHtml(state.newWa.body)}</textarea>
      ${state.newWaErr ? `<div class="gate-error" style="min-height:0">${escapeHtml(state.newWaErr)}</div>` : ""}
      <div class="add-form-actions">
        <button class="btn btn-primary" id="nw-send">${ICON.send} Send</button>
        <button class="btn btn-ghost" id="nw-cancel">Cancel</button>
      </div>
    </div>`;
}

function wireNewWaForm(root) {
  const to = $("#nw-to", root);
  if (!to) return;
  to.oninput = (e) => (state.newWa.to = e.target.value);
  $("#nw-body", root).oninput = (e) => (state.newWa.body = e.target.value);
  $("#nw-send", root).onclick = sendNewWa;
  $("#nw-cancel", root).onclick = toggleNewWa;
}

async function sendNewWa() {
  const to = state.newWa.to.trim();
  const body = state.newWa.body.trim();
  if (!to || !body) { state.newWaErr = "Number and message are both required."; return renderWhatsappTab($("#content")); }
  try {
    await api("/whatsapp", { method: "POST", body: JSON.stringify({ to, body }) });
    state.showNewWa = false;
    state.newWa = { to: "", body: "" };
    state.newWaErr = "";
    state.whatsapp = await api("/whatsapp", { auth: false });
    state.selectedWaPeer = waThreadPeers()[0] || state.selectedWaPeer;
    render();
  } catch (e) {
    if (e.status === 401) return showGate("Session token rejected — re-enter it to send WhatsApp.");
    state.newWaErr = "Couldn't send (" + e.message + ").";
    renderWhatsappTab($("#content"));
  }
}

// queued/sent/delivered mirror SMS's glyphs; "read" gets its own (blue, via .wa-status.read)
// to match WhatsApp's own double-tick convention.
const WA_STATUS_GLYPH = { queued: "·", sent: "✓", delivered: "✓✓", read: "✓✓", failed: "⚠", received: "" };

function waBubbleHtml(m) {
  const glyph = m.direction === "outbound" ? (WA_STATUS_GLYPH[m.status] ?? "") : "";
  const cls = m.status === "failed" ? "sms-status failed" : m.status === "read" ? "sms-status read" : "sms-status";
  const meta = glyph
    ? `<span class="${cls}" title="${escapeHtml(m.status + (m.error ? ": " + m.error : ""))}">${glyph}</span>`
    : "";
  return `<div class="sms-bubble ${escapeHtml(m.direction)}">${escapeHtml(m.body)}${meta}</div>`;
}

function renderWaThread(root) {
  const peer = state.selectedWaPeer;
  if (!peer) { root.innerHTML = `<div class="section-empty">No conversations yet.</div>`; return; }
  const msgs = state.whatsapp.filter((m) => m.peer === peer);
  const contact = state.contacts.find((c) => c.phoneE164 === peer);
  const title = contact && contact.name ? contact.name : peer;
  const trust = contact ? `<span class="badge ${TRUST_BADGE[contact.trustTier] || "badge-muted"}">${escapeHtml(contact.trustTier)}</span>` : "";
  root.innerHTML = `
    <div class="thread-head">
      <span class="detail-peer" style="font-size:14px">${escapeHtml(title)}</span>
      ${contact && contact.name ? `<span class="list-row-sub mono" style="margin-left:8px">${escapeHtml(peer)}</span>` : ""}
      ${trust}
    </div>
    <div class="thread-messages">${msgs.map(waBubbleHtml).join("")}</div>
    <div class="sms-bar"><input class="in" id="wa-input" placeholder="Type a message…" value="${escapeHtml(state.waDraft)}" /><button class="btn btn-primary" id="btn-send-wa">${ICON.send} Send</button></div>
  `;
  const box = $(".thread-messages", root);
  if (box) box.scrollTop = box.scrollHeight;
  $("#wa-input").oninput = (e) => (state.waDraft = e.target.value);
  $("#btn-send-wa").onclick = sendWa;
}

async function sendWa() {
  const peer = state.selectedWaPeer;
  const body = state.waDraft.trim();
  if (!peer || !body) return;
  try {
    await api("/whatsapp", { method: "POST", body: JSON.stringify({ to: peer, body }) });
    state.waDraft = "";
    state.whatsapp = await api("/whatsapp", { auth: false });
    render();
  } catch (e) {
    if (e.status === 401) showGate("Session token rejected — re-enter it to send WhatsApp.");
    else alert("Send failed (" + e.message + ")");
  }
}

// ---------------------------------------------------------------------------------------
// devices tab
// ---------------------------------------------------------------------------------------

function renderDevicesTab(root) {
  root.innerHTML = `
    <div style="flex:1;overflow-y:auto">
      <div class="col-head"><div class="col-title"><h2>Devices</h2><span class="sub">${state.devices.length} connected</span></div></div>
      <div class="devices-grid">
        ${state.devices.length ? state.devices.map((d) => {
          const activeCalls = state.calls.filter((c) => c.deviceId === d.id && c.status !== "ended").length;
          return `<div class="device-card">
            <div class="device-card-top"><span class="dot pulse" style="background:var(--ok);color:var(--ok)"></span><span class="id">${escapeHtml(d.id)}</span><span class="badge badge-ok" style="margin-left:auto">connected</span></div>
            <div class="device-stat"><span>Connected</span><b>${escapeHtml(relTime(d.connectedAt))}</b></div>
            <div class="device-stat"><span>Last seen</span><b>${escapeHtml(relTime(d.lastSeen))}</b></div>
            <div class="device-stat"><span>Active calls</span><b>${activeCalls}</b></div>
          </div>`;
        }).join("") : `<div class="empty-state">No phone-connector devices are currently linked.</div>`}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------------------

boot();
