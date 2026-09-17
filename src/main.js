import "./style.css";
import {
  MatrixPeer,
  login,
  registerAuto,
  randomUsername,
  shareUrl,
  parseShareUrl,
  deviceKey,
} from "./matrix.js";
import { RtcPeer } from "./rtc.js";
import { WorkerEngine, MODEL_CHOICES, DEFAULT_MODEL, webgpuAvailable } from "./llm.js";
import { el, statusDot, copyBtn, toast, deviceName, publicIp, countdownText } from "./ui.js";

const DEFAULT_HS = "https://hyphae.social";
const SESSION_KEY = "heimdall.session.v1";
const MODEL_KEY = "heimdall.model.v1";
const NAME_KEY = "heimdall.name.v1";

const INVITE_TTL = 7 * 24 * 3600 * 1000; // a share link is good for 7 days
const LEASE_TTL = 12 * 3600 * 1000; // an accepted lease lasts 12h, then must be renewed

const FOLD_REPO = "https://github.com/clovenbradshaw-ctrl/the-fold.git";
const FOLD_WEB = "https://clovenbradshaw-ctrl.github.io/the-fold/";
const FOLD_CMD = `git clone ${FOLD_REPO} && cd the-fold && ./fold`;

const share = parseShareUrl();
const mode = share ? "worker" : "controller";

const app = {
  mode,
  hs: share?.baseUrl || DEFAULT_HS,
  roomId: share?.roomId || null,
  session: loadSession(),
  modelId: localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL,
  displayName: localStorage.getItem(NAME_KEY) || "",
  matrix: null,
  creatorId: null,
  workers: new Map(), // controller: deviceKey -> worker record
  peers: new Map(), // worker: controller deviceKey -> RtcPeer
  connecting: new Map(), // controller: deviceKey -> timestamp
  engine: null,
  wakeLock: null,
  note: "",
  leaseUntil: 0,
  leaseExpired: false,
  renewRequested: false,
  myIp: null,
  timers: [],
  ledger: new Map(), // deviceKey -> { give, borrow }
  relay: new Map(), // job id -> { giverKey, borrowerKey, borrowerRec }
  giverIdx: 0,
  lendDevice: false,
  hubEngine: null,
  credit: { give: 0, borrow: 0, credit: 0 },
};

/* ---------------------------------------------------------------- storage */

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function saveSession(partial = {}) {
  app.session = { ...(app.session || {}), ...partial };
  localStorage.setItem(SESSION_KEY, JSON.stringify(app.session));
}

function clearSession() {
  app.session = null;
  localStorage.removeItem(SESSION_KEY);
  toast("session cleared");
}

function randomBytes() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "x");
}

/* ---------------------------------------------------------------- matrix */

async function ensureMatrix() {
  if (app.matrix) return app.matrix;
  let creds = app.session?.creds;
  if (!creds) {
    const password = randomBytes();
    creds = await registerAuto({ baseUrl: app.hs, username: randomUsername(), password });
    saveSession({ creds });
  }
  const matrix = new MatrixPeer({
    ...creds,
    onSignal,
    onSync: () => {},
    onMembers: () => {
      if (mode === "controller") reconcile();
    },
  });
  app.matrix = matrix;
  await matrix.start();
  return matrix;
}

async function tryLogin({ baseUrl, username, password }) {
  const creds = await login({ baseUrl, username, password });
  saveSession({ creds });
  location.reload();
}

/* ------------------------------------------------------------- signaling */

function onSignal(senderUserId, content) {
  if (content.type === "signal") {
    const key = deviceKey({ userId: senderUserId, deviceId: content.deviceId });
    if (mode === "controller") {
      const rec = app.workers.get(key);
      if (rec?.peer) rec.peer.handleSignal(content.label, content.data).catch(() => {});
    } else {
      if (app.creatorId && senderUserId !== app.creatorId) return;
      const remote = { userId: senderUserId, deviceId: content.deviceId };
      const peer = ensureWorkerPeer(remote);
      if (peer.opened) return;
      peer.handleSignal(content.label, content.data).catch(() => {});
    }
  } else if (content.type === "ready" && mode === "controller") {
    reconcile();
  }
}

/* ------------------------------------------------------------ controller */

function buildInviteUrl() {
  const name = app.displayName || app.matrix.userId;
  const exp = Date.now() + INVITE_TTL;
  app.invite = { name, exp };
  saveSession({ invite: app.invite });
  const base = shareUrl(app.roomId, app.hs);
  return `${base}&host=${encodeURIComponent(app.matrix.userId)}&name=${encodeURIComponent(name)}&exp=${exp}`;
}

function refreshShareBox() {
  if (!shareBoxEl || !app.roomId) return;
  shareBoxEl.value = buildInviteUrl();
  shareBoxEl.disabled = false;
  inviteExpiryEl.textContent = `link expires ${countdownText(app.invite.exp)} — renew to keep it alive`;
}

async function createRoom() {
  try {
    const matrix = await ensureMatrix();
    const roomId = await matrix.createFleetRoom();
    saveSession({ roomId });
    app.roomId = roomId;
    fleetCardEl.hidden = false;
    promptCardEl.hidden = false;
    refreshShareBox();
    toast("fleet room ready — send the link");
    setInterval(() => reconcile(), 15000);
    await reconcile();
  } catch (e) {
    toast(`could not create room: ${e.message}`);
  }
}

async function rejoin() {
  if (!app.session?.roomId) return;
  try {
    const matrix = await ensureMatrix();
    await matrix.joinRoom(app.session.roomId);
    app.roomId = app.session.roomId;
    fleetCardEl.hidden = false;
    promptCardEl.hidden = false;
    refreshShareBox();
    toast("rejoined fleet");
    setInterval(() => reconcile(), 15000);
    await reconcile();
  } catch (e) {
    toast(`could not rejoin: ${e.message}`);
  }
}

async function lendMyDevice() {
  if (app.lendDevice) return;
  app.lendDevice = true;
  lendBtnEl.disabled = true;
  lendStatusEl.textContent = "loading model…";
  app.hubEngine = new WorkerEngine((p) => {
    lendStatusEl.textContent = p.text || `loading model ${Math.round((p.progress || 0) * 100)}%`;
  });
  try {
    await app.hubEngine.load(app.modelId);
    lendStatusEl.textContent = `${app.modelId} — you lend compute now`;
    toast("you are giving compute back to the fleet");
    renderFleet();
  } catch (e) {
    app.lendDevice = false;
    lendBtnEl.disabled = false;
    lendStatusEl.textContent = `failed: ${e.message}`;
  }
}

async function reconcile() {
  if (!app.matrix || !app.roomId) return;
  const members = app.matrix.roomMembers();
  for (const userId of members) {
    const devs = await app.matrix.devicesOf(userId, { retry: 0 });
    for (const device of devs) {
      const key = deviceKey(device);
      if (app.workers.has(key)) continue;
      const last = app.connecting.get(key) || 0;
      if (Date.now() - last < 30000) continue;
      app.connecting.set(key, Date.now());
      ensureWorkerLink(key, device);
    }
  }
}

function ensureWorkerLink(key, device) {
  const rec = {
    device,
    peer: null,
    status: "linking",
    hello: null,
    lastSeen: null,
    renewed: false,
  };
  app.workers.set(key, rec);
  renderFleet();

  const peer = new RtcPeer({
    signal: (label, data) =>
      app.matrix
        .sendSignalRetry(device, { type: "signal", deviceId: app.matrix.deviceId, label, data })
        .then(() => {}),
    onOpen: () => {
      rec.status = "open";
      rec.lastSeen = Date.now();
      renderFleet();
    },
    onClose: () => {
      rec.status = "lost";
      renderFleet();
      const retry = setTimeout(() => {
        app.workers.delete(key);
        app.connecting.delete(key);
        reconcile();
      }, 5000);
      app.timers.push(retry);
    },
    onMessage: (msg) => onWorkerMessage(key, rec, msg),
  });
  rec.peer = peer;
  peer.offer().catch(() => {
    app.workers.delete(key);
    app.connecting.delete(key);
  });
}

function onWorkerMessage(key, rec, msg) {
  // A relayed job: worker borrowed from the fleet, tokens come back via the hub.
  if (msg.type === "token" && app.relay.has(msg.id)) {
    const r = app.relay.get(msg.id);
    if (r.borrowerRec?.peer?.opened) r.borrowerRec.peer.send({ type: "token", id: msg.id, text: msg.text });
    return;
  }
  if ((msg.type === "result" || msg.type === "error") && app.relay.has(msg.id)) {
    const r = app.relay.get(msg.id);
    app.relay.delete(msg.id);
    if (msg.type === "result") settle(r.giverKey, r.borrowerKey);
    if (r.borrowerRec?.peer?.opened) {
      r.borrowerRec.peer.send({ type: msg.type, id: msg.id, text: msg.text, duration_ms: msg.duration_ms, message: msg.message });
    }
    renderFleet();
    return;
  }
  // A worker borrowing from the fleet (reciprocal path).
  if (msg.type === "job") {
    onBorrowJob(key, rec, msg);
    return;
  }
  if (msg.type === "hello") {
    rec.hello = msg;
    rec.status = "ready";
    rec.lastSeen = Date.now();
    renderFleet();
  } else if (msg.type === "lease") {
    rec.hello = { ...(rec.hello || {}), leaseUntil: msg.until };
    rec.renewed = true;
    rec.status = "ready";
    rec.lastSeen = Date.now();
    renderFleet();
  } else if (msg.type === "ping") {
    rec.lastSeen = Date.now();
  } else if (msg.type === "token") {
    consolePush(msg.id, msg.text);
  } else if (msg.type === "result") {
    consolePush(msg.id, `\n[done ${msg.duration_ms}ms]\n`);
    rec.lastSeen = Date.now();
    // The hub borrowed from this worker — it gave compute. Credit it.
    const l = app.ledger.get(key) || { give: 0, borrow: 0 };
    l.give++;
    app.ledger.set(key, l);
    pushCredit(key, l);
    renderFleet();
  } else if (msg.type === "error") {
    consolePush(msg.id, `\n[error] ${msg.message}\n`);
    rec.status = "ready";
    renderFleet();
  }
}

/* ------------------------------------------------------- reciprocal ledger */

function ledgerOf(key) {
  return app.ledger.get(key) || { give: 0, borrow: 0 };
}

function pushCredit(key, l) {
  const rec = app.workers.get(key);
  if (rec?.peer?.opened) {
    rec.peer.send({ type: "credit", give: l.give, borrow: l.borrow, credit: l.give - l.borrow });
  }
}

function settle(giverKey, borrowerKey) {
  if (giverKey !== "self") {
    const g = ledgerOf(giverKey);
    g.give++;
    app.ledger.set(giverKey, g);
    pushCredit(giverKey, g);
  }
  const b = ledgerOf(borrowerKey);
  b.borrow++;
  app.ledger.set(borrowerKey, b);
  pushCredit(borrowerKey, b);
}

function onBorrowJob(borrowerKey, rec, msg) {
  const l = ledgerOf(borrowerKey);
  if (l.borrow >= l.give) {
    rec.peer.send({ type: "error", id: msg.id, message: "no credit — you have to give compute before you can borrow. Serve a job first." });
    return;
  }
  const giver = pickGiver(borrowerKey);
  if (!giver) {
    rec.peer.send({ type: "error", id: msg.id, message: "no giver available right now" });
    return;
  }
  const req = {
    type: "infer",
    id: msg.id,
    messages: msg.messages || [{ role: "user", content: msg.prompt }],
    stream: true,
    temperature: msg.temperature ?? 0.7,
    max_tokens: msg.max_tokens ?? 1024,
  };
  app.relay.set(msg.id, { giverKey: giver.key, borrowerKey, borrowerRec: rec });
  if (giver.key === "self") {
    serveSelf(req, rec);
  } else {
    giver.rec.peer.send(req);
  }
}

function pickGiver(borrowerKey) {
  const ready = [...app.workers.values()].filter((w) => {
    const key = deviceKey(w.device);
    const leaseDead = w.hello?.leaseUntil && Date.now() > w.hello.leaseUntil;
    return key !== borrowerKey && w.status === "ready" && w.peer?.opened && !leaseDead;
  });
  if (ready.length === 0) {
    return app.lendDevice && app.hubEngine?.loaded ? { key: "self" } : null;
  }
  const pick = ready[app.giverIdx % ready.length];
  app.giverIdx++;
  return { key: deviceKey(pick.device), rec: pick };
}

async function serveSelf(req, borrowerRec) {
  const t0 = Date.now();
  try {
    const { text } = await app.hubEngine.infer(
      req.messages,
      { stream: true, temperature: req.temperature, max_tokens: req.max_tokens },
      (delta) => borrowerRec.peer?.send({ type: "token", id: req.id, text: delta }),
    );
    settle("self", app.relay.get(req.id)?.borrowerKey || "");
    borrowerRec.peer?.send({ type: "result", id: req.id, text, duration_ms: Date.now() - t0 });
  } catch (e) {
    borrowerRec.peer?.send({ type: "error", id: req.id, message: String(e?.message || e) });
  } finally {
    app.relay.delete(req.id);
  }
}

function nudgeRenew(key) {
  const rec = app.workers.get(key);
  if (rec?.peer?.opened) rec.peer.send({ type: "renew" });
}

function sendInferAll() {
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  const id = crypto.randomUUID();
  consolePush(id, `▶ ${prompt}\n`);
  let sent = 0;
  for (const rec of app.workers.values()) {
    if (rec.peer?.opened && rec.status !== "expired") {
      rec.peer.send({
        type: "infer",
        id,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        temperature: 0.7,
        max_tokens: 1024,
      });
      sent++;
    }
  }
  if (!sent) toast("no live workers connected");
}

function consolePush(id, text) {
  if (!consoleEl) return;
  consoleEl.textContent += text;
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

/* ---------------------------------------------------------------- worker */

function inviteExpired() {
  return !!share.exp && Date.now() > share.exp;
}

async function acceptDuty() {
  if (inviteExpired()) {
    toast(`this invite expired — ask ${share.name || "the host"} for a fresh link`);
    return;
  }
  const msg = noteEl?.value?.trim() || app.note;
  if (!msg) {
    toast("write a message to the host before accepting");
    return;
  }
  app.note = msg;
  acceptBtnEl.disabled = true;
  acceptBtnEl.textContent = "Joining…";
  try {
    const matrix = await ensureMatrix();
    await matrix.joinRoom(app.roomId);
    app.creatorId = matrix.roomCreator();
    renderIdentity();

    statusEl.textContent = "Loading model…";
    if (app.engine === null) {
      app.engine = new WorkerEngine((p) => {
        if (p.progress > 0) progressEl.hidden = false;
        progressFillEl.style.width = `${Math.round((p.progress || 0) * 100)}%`;
        modelStatusEl.textContent = p.text || "downloading model";
      });
    }
    await app.engine.load(app.modelId);
    progressEl.hidden = true;
    modelStatusEl.textContent = `${app.modelId} — loaded`;

    app.leaseUntil = Date.now() + LEASE_TTL;
    app.leaseExpired = false;
    app.renewRequested = false;
    localStorage.setItem(`heimdall.lease.${app.roomId}`, String(app.leaseUntil));
    for (const peer of app.peers.values()) {
      if (peer.opened) peer.send({ type: "lease", until: app.leaseUntil });
    }
    statusEl.textContent = `Standing by until ${countdownText(app.leaseUntil)}`;
    acceptBtnEl.textContent = "Renew compute duties";

    await announceReady();
    setInterval(() => announceReady(), 20000);
    setInterval(() => {
      for (const peer of app.peers.values()) {
        if (peer.opened) peer.send({ type: "ping", t: Date.now() });
      }
    }, 15000);
    await keepAwake();
    renderWorkerStatus();
    toast("you are compute now. keep this tab open.");
  } catch (e) {
    acceptBtnEl.disabled = false;
    acceptBtnEl.textContent = "Accept compute duties";
    statusEl.textContent = `failed: ${e.message}`;
    toast(`accept failed: ${e.message}`);
  }
}

async function announceReady() {
  if (!app.matrix || !app.creatorId || !app.leaseUntil) return;
  const devs = await app.matrix.devicesOf(app.creatorId, { retry: 0 });
  for (const device of devs) {
    await app.matrix.sendSignalRetry(
      device,
      {
        type: "ready",
        deviceId: app.matrix.deviceId,
        model: app.modelId,
        name: deviceName(),
        note: app.note,
        leaseUntil: app.leaseUntil,
      },
      3,
    );
  }
}

function ensureWorkerPeer(remoteDevice) {
  const key = deviceKey(remoteDevice);
  if (app.peers.has(key)) return app.peers.get(key);
  const peer = new RtcPeer({
    signal: (label, data) =>
      app.matrix
        .sendSignalRetry(remoteDevice, { type: "signal", deviceId: app.matrix.deviceId, label, data })
        .then(() => {}),
    onOpen: () => {
      renderWorkerStatus();
      peer.send({
        type: "hello",
        role: "worker",
        deviceId: app.matrix.deviceId,
        model: app.modelId,
        name: deviceName(),
        ua: navigator.userAgent,
        note: app.note,
        leaseUntil: app.leaseUntil,
      });
    },
    onClose: () => renderWorkerStatus(),
    onMessage: (msg) => onWorkerRtcMessage(peer, msg),
  });
  app.peers.set(key, peer);
  return peer;
}

async function onWorkerRtcMessage(peer, msg) {
  if (msg.type === "renew") {
    app.renewRequested = true;
    renderWorkerStatus();
    toast(`${share.name || "the host"} asked you to renew your compute lease`);
    return;
  }
  if (msg.type === "credit") {
    app.credit = { give: msg.give, borrow: msg.borrow, credit: msg.credit };
    renderWorkerStatus();
    updateComposer();
    return;
  }
  if (msg.type === "token") {
    workerConsolePush(msg.text);
    return;
  }
  if (msg.type === "result") {
    workerConsolePush(`\n[done ${msg.duration_ms}ms]\n`);
    return;
  }
  if (msg.type === "error") {
    workerConsolePush(`\n[error] ${msg.message}\n`);
    return;
  }
  if (msg.type !== "infer") return;
  if (!app.engine) {
    peer.send({ type: "error", id: msg.id, message: "engine not ready" });
    return;
  }
  if (app.leaseExpired || !app.leaseUntil || Date.now() > app.leaseUntil) {
    peer.send({ type: "error", id: msg.id, message: "compute lease expired — renew to keep serving" });
    return;
  }
  const t0 = Date.now();
  try {
    const { text } = await app.engine.infer(
      msg.messages || [{ role: "user", content: msg.prompt }],
      {
        stream: msg.stream !== false,
        temperature: msg.temperature ?? 0.7,
        max_tokens: msg.max_tokens ?? 1024,
      },
      (delta) => peer.send({ type: "token", id: msg.id, text: delta }),
    );
    peer.send({ type: "result", id: msg.id, text, duration_ms: Date.now() - t0 });
    renderWorkerStatus();
  } catch (e) {
    peer.send({ type: "error", id: msg.id, message: String(e?.message || e) });
  }
}

function borrowNow() {
  const prompt = borrowEl?.value?.trim();
  if (!prompt) return;
  if (app.credit.credit <= 0) {
    toast("no credit — serve compute to the fleet first, then borrow");
    return;
  }
  const peer = [...app.peers.values()].find((p) => p.opened);
  if (!peer) {
    toast("not connected to the fleet");
    return;
  }
  workerConsolePush(`▶ ${prompt}\n`);
  peer.send({ type: "job", id: crypto.randomUUID(), prompt, temperature: 0.7, max_tokens: 1024 });
}

function workerConsolePush(text) {
  if (!workerConsoleEl) return;
  workerConsoleEl.textContent += text;
  workerConsoleEl.scrollTop = workerConsoleEl.scrollHeight;
}

function updateComposer() {
  if (!borrowBtnEl) return;
  const can = app.credit.credit > 0;
  borrowBtnEl.disabled = !can;
  borrowHintEl.textContent = can
    ? `credit ${app.credit.credit} — you can borrow`
    : "you have not given any compute yet — serve a job first, then you can borrow";
}

async function keepAwake() {
  try {
    if ("wakeLock" in navigator) {
      app.wakeLock = await navigator.wakeLock.request("screen");
      document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible") {
          try {
            app.wakeLock = await navigator.wakeLock.request("screen");
          } catch {}
        }
      });
    }
  } catch {}
}

/* ------------------------------------------------------------------- view */

let shareBoxEl, inviteExpiryEl, fleetCardEl, promptCardEl, promptEl, consoleEl, lendBtnEl, lendStatusEl;
let acceptBtnEl, statusEl, progressEl, progressFillEl, modelStatusEl, noteEl, identityEl, borrowEl, borrowBtnEl, borrowHintEl, workerConsoleEl;

function header() {
  return el("header", { class: "site" }, [
    el("h1", { text: "heimdall" }),
    el("span", { class: "sub", text: "distributed local inference — matrix + webrtc + webllm" }),
  ]);
}

function foldCard() {
  return el("div", { class: "card" }, [
    el("h2", { text: "Also: the fold" }),
    el("p", { class: "muted", text: "The same page can stand up the fold — a personal reading instrument that remembers everything you discuss with it. Two ways in:" }),
    el("div", { class: "col" }, [
      el("div", { class: "row" }, [
        el("span", { class: "badge ok", text: "try it" }),
        el("a", { href: FOLD_WEB, target: "_blank", rel: "noopener", text: "open the fold in this browser — WebGPU, no install" }),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "badge", text: "run it" }),
        el("code", { text: FOLD_CMD }),
        copyBtn("copy", () => FOLD_CMD),
      ]),
    ]),
  ]);
}

function loginCard() {
  const hs = el("input", { value: app.hs, placeholder: "https://homeserver" });
  const user = el("input", { placeholder: "username" });
  const pass = el("input", { type: "password", placeholder: "password" });
  const out = el("div", { class: "col" }, [
    el("label", { text: "homeserver" }), hs,
    el("label", { text: "username" }), user,
    el("label", { text: "password" }), pass,
    el("button", {
      class: "primary",
      text: "Sign in with my own account",
      onclick: async () => {
        try {
          await tryLogin({ baseUrl: hs.value.trim(), username: user.value.trim(), password: pass.value });
        } catch (e) {
          toast(`login failed: ${e.message}`);
        }
      },
    }),
  ]);
  return el("div", { class: "card", hidden: false }, [
    el("h2", { text: "optional: use your own matrix account" }),
    el("p", { class: "muted", text: "By default every device auto-creates a throwaway account on hyphae.social. Sign in here instead if you want a real account." }),
    out,
  ]);
}

function controllerView() {
  const nameEl = el("input", { value: app.displayName, placeholder: "your name shown to workers" });
  nameEl.addEventListener("change", () => {
    app.displayName = nameEl.value.trim();
    localStorage.setItem(NAME_KEY, app.displayName);
    if (app.roomId) refreshShareBox();
  });

  shareBoxEl = el("input", { readonly: true, value: "", placeholder: "share link appears here" });
  inviteExpiryEl = el("div", { class: "muted small" });
  const shareRow = el("div", { class: "linkbox" }, [
    shareBoxEl,
    copyBtn("copy", () => shareBoxEl.value),
    el("button", { class: "ghost small", text: "renew link", onclick: refreshShareBox }),
  ]);

  const createBtn = el("button", {
    class: "primary",
    text: app.session?.roomId ? "Rejoin last fleet" : "Create fleet room",
    onclick: () => (app.session?.roomId ? rejoin() : createRoom()),
  });
  const freshBtn = el("button", { class: "ghost", text: "New room", onclick: createRoom });

  fleetCardEl = el("div", { class: "card", hidden: true }, [
    el("h2", { text: "Workers" }),
    el("ul", { class: "fleet", id: "fleet" }),
  ]);

  promptEl = el("textarea", { placeholder: "send a prompt to every connected worker…" });
  consoleEl = el("div", { class: "console", text: "" });
  promptCardEl = el("div", { class: "card", hidden: true }, [
    el("h2", { text: "Run" }),
    promptEl,
    el("div", { class: "row" }, [
      el("button", { class: "primary", text: "Run on all workers", onclick: sendInferAll }),
      el("button", { class: "ghost small", text: "clear log", onclick: () => (consoleEl.textContent = "") }),
    ]),
    consoleEl,
  ]);

  lendBtnEl = el("button", {
    class: "ghost",
    text: "Lend my device",
    onclick: lendMyDevice,
  });
  lendStatusEl = el("div", { class: "muted small" });
  const lendCard = el("div", { class: "card" }, [
    el("h2", { text: "Give compute" }),
    el("p", { class: "muted", text: "Inference runs both ways. Lend this device too, and you earn credit back to the fleet instead of only borrowing." }),
    el("div", { class: "row" }, [lendBtnEl, lendStatusEl]),
  ]);

  return el("div", { class: "view" }, [
    header(),
    el("div", { class: "card" }, [
      el("h2", { text: "Fleet" }),
      el("p", { class: "muted", text: "The link names you, carries an expiry, and makes the worker show its own IP before accepting. The room is only a directory — prompts and answers travel device-to-device over WebRTC, never through the room. Everyone who borrows must first give." }),
      el("label", { text: "your name" }),
      nameEl,
      el("div", { class: "row", style: "" }, [createBtn, freshBtn]),
      shareRow,
      inviteExpiryEl,
    ]),
    fleetCardEl,
    promptCardEl,
    lendCard,
    foldCard(),
    loginCard(),
    footer(),
  ]);
}

function renderFleet() {
  const ul = document.getElementById("fleet");
  if (!ul) return;
  ul.replaceChildren();
  if (app.workers.size === 0) {
    ul.append(el("li", { class: "muted", text: "No workers yet. Share the link and wait for an accept." }));
    return;
  }
  for (const [key, rec] of app.workers) {
    const h = rec.hello;
    const color = rec.status === "ready" ? "ok" : rec.status === "expired" ? "err" : rec.status === "lost" ? "err" : "warn";
    const name = h?.name || rec.device.userId;
    const meta = h
      ? `${h.model || ""}${h.note ? ` · said “${h.note.slice(0, 48)}${h.note.length > 48 ? "…" : ""}”` : ""}`
      : `linking…`;
    const l = ledgerOf(key);
    const credit = l.give || l.borrow
      ? ` · gave ${l.give} took ${l.borrow}`
      : "";
    const lease = el("span", {
      class: "countdown muted",
      "data-until": h?.leaseUntil || 0,
      text: h?.leaseUntil ? countdownText(h.leaseUntil) : "…",
    });
    ul.append(
      el("li", { class: "worker" }, [
        statusDot(color, rec.status),
        el("div", { class: "who" }, [
          el("div", { class: "name", text: name }),
          el("div", { class: "meta", text: meta + credit }),
          el("div", { class: "meta", text: lastSeenText(rec.lastSeen) + (rec.renewed ? " · renewed" : "") }),
        ]),
        lease,
        el("button", { class: "ghost small", text: "renew", onclick: () => nudgeRenew(key) }),
      ]),
    );
  }
}

function lastSeenText(ts) {
  if (!ts) return "…";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function workerView() {
  const roomBox = el("div", { class: "row" }, [
    el("span", { class: "badge", text: `room ${app.roomId}` }),
    el("span", { class: "badge", text: app.hs }),
  ]);

  identityEl = el("div", { class: "col" });
  renderIdentity();

  const who = share.name || share.host || "someone";
  const ipEl = el("span", { class: "muted small", text: "looking up your IP…" });
  publicIp().then((ip) => {
    app.myIp = ip;
    ipEl.textContent = `Your public IP: ${ip} — the host can see this (and your device type) once you connect.`;
  });

  const modelSel = el(
    "select",
    {},
    MODEL_CHOICES.map((m) =>
      el("option", { value: m.id, selected: m.id === app.modelId ? "" : null, text: m.label }),
    ),
  );
  modelSel.addEventListener("change", () => {
    app.modelId = modelSel.value;
    localStorage.setItem(MODEL_KEY, app.modelId);
  });

  noteEl = el("textarea", { placeholder: `write a message to ${who} — why you’re lending compute…` });

  const acceptCard = el("div", { class: "card" });
  acceptBtnEl = el("button", { class: "primary big", text: "Accept compute duties", onclick: acceptDuty });
  progressEl = el("div", { class: "progress", hidden: true });
  progressFillEl = el("div");
  progressEl.append(progressFillEl);

  const expLine = el("div", {
    class: "muted small",
    text: share.exp ? `this invite ${countdownText(share.exp)}` : "no expiry set on this link — treat it with care",
  });

  acceptCard.append(
    el("h2", { text: "Lend this device" }),
    el("p", { class: "muted", text: `Accepting runs a small language model in this tab and makes it available to ${who}. Nothing is stored on a server; your device does the compute. The lease lasts 12 hours and must be renewed. Inference is mutual — you lend your compute, and you can borrow from the fleet only what you have given.` }),
    el("label", { text: "model" }),
    modelSel,
    el("div", { class: "row" }, [
      webgpuAvailable()
        ? el("span", { class: "badge ok", text: "WebGPU ready" })
        : el("span", { class: "badge warn", text: "no WebGPU — inference will be slow or fail" }),
      el("span", { class: "badge", text: deviceName() }),
    ]),
    el("div", { style: "height:10px" }),
    el("label", { text: "message to the host (required)" }),
    noteEl,
    el("div", { style: "height:10px" }),
    acceptBtnEl,
    expLine,
    progressEl,
  );

  statusEl = el("div", { class: "col" });
  modelStatusEl = el("span", { class: "muted small" });

  borrowEl = el("textarea", { placeholder: "borrow compute from the fleet — ask anything…" });
  borrowBtnEl = el("button", { class: "primary", text: "Borrow compute", disabled: "", onclick: borrowNow });
  borrowHintEl = el("div", { class: "muted small", text: "you have not given any compute yet — serve a job first, then you can borrow" });
  workerConsoleEl = el("div", { class: "console", text: "" });
  const borrowCard = el("div", { class: "card" }, [
    el("h2", { text: "Borrow compute" }),
    el("p", { class: "muted", text: "Inference is mutual: you give compute by serving jobs, and you can borrow from the fleet only what you have already given." }),
    borrowEl,
    el("div", { class: "row" }, [borrowBtnEl, borrowHintEl]),
    workerConsoleEl,
  ]);

  return el("div", { class: "view" }, [
    header(),
    roomBox,
    el("div", { class: "card" }, [
      el("h2", { text: "Who is asking" }),
      identityEl,
      ipEl,
    ]),
    acceptCard,
    el("div", { class: "card", id: "worker-status" }, [
      el("h2", { text: "Status" }),
      statusEl,
      modelStatusEl,
    ]),
    borrowCard,
    foldCard(),
    loginCard(),
    footer(),
  ]);
}

function renderIdentity() {
  if (!identityEl) return;
  const name = share.name || share.host || "someone";
  const parts = [
    el("div", { class: "who" }, [
      el("div", { class: "name", text: name }),
      el("div", { class: "meta", text: share.host ? `matrix id: ${share.host}` : "no matrix id claimed in this link" }),
    ]),
  ];
  if (share.host) {
    if (app.creatorId) {
      if (app.creatorId === share.host) {
        parts.push(el("div", { class: "alert ok", text: "identity verified — the room was created by the account this link claims" }));
      } else {
        parts.push(el("div", { class: "alert err", text: `warning: the link claims ${share.host} but the room was actually created by ${app.creatorId}` }));
      }
    } else {
      parts.push(el("div", { class: "alert warn", text: "identity claim not yet verified — it will be checked once you join" }));
    }
  }
  identityEl.replaceChildren(...parts);
}

function renderWorkerStatus() {
  const box = document.getElementById("worker-status");
  if (!box || !statusEl) return;
  const online = [...app.peers.values()].filter((p) => p.opened).length;
  const leaseBadge = app.leaseExpired
    ? el("span", { class: "badge err", text: "lease expired" })
    : app.leaseUntil
      ? el("span", { class: "countdown badge ok", "data-until": app.leaseUntil, text: `lease ${countdownText(app.leaseUntil)}` })
      : el("span", { class: "badge", text: "no lease yet" });
  const creditBadge = el("span", {
    class: `badge ${app.credit.credit > 0 ? "ok" : "warn"}`,
    text: `credit ${app.credit.credit} (gave ${app.credit.give}, took ${app.credit.borrow})`,
  });
  const renewBtn = app.leaseExpired || app.renewRequested
    ? el("button", { class: "primary small", text: "Renew now", onclick: acceptDuty })
    : null;
  const lines = [
    el("div", { class: "row" }, [
      el("span", { class: "badge", text: `links: ${online}` }),
      app.wakeLock ? el("span", { class: "badge ok", text: "screen awake" }) : null,
      el("span", { class: "badge", text: `model: ${app.modelId}` }),
      creditBadge,
      leaseBadge,
      renewBtn,
    ]),
  ].filter(Boolean);
  statusEl.replaceChildren(...lines);
}

function footer() {
  return el("div", { class: "foot" }, [
    el("span", { text: "heimdall — matrix signaling · webrtc data · webllm compute. the fold docks here too." }),
    el("span", { style: "margin-left:8px" }),
    el("button", { class: "ghost small", text: "reset session", onclick: () => { clearSession(); location.reload(); } }),
  ]);
}

/* ------------------------------------------------------------------ tick */

setInterval(tick, 1000);

function tick() {
  document.querySelectorAll(".countdown[data-until]").forEach((elNode) => {
    const until = Number(elNode.dataset.until);
    elNode.textContent = until ? countdownText(until) : "…";
  });
  if (mode === "worker") workerTick();
  if (mode === "controller") controllerTick();
}

function workerTick() {
  if (app.leaseUntil && !app.leaseExpired && Date.now() > app.leaseUntil) {
    app.leaseExpired = true;
    renderWorkerStatus();
    toast("your compute lease expired — renew to keep serving");
  }
}

function controllerTick() {
  for (const rec of app.workers.values()) {
    if (rec.hello?.leaseUntil && Date.now() > rec.hello.leaseUntil && rec.status !== "expired") {
      rec.status = "expired";
      nudgeRenew(deviceKey(rec.device));
      renderFleet();
    }
  }
}

/* ------------------------------------------------------------------ boot */

function main() {
  const root = document.getElementById("app");
  root.append(mode === "controller" ? controllerView() : workerView());
  if (mode === "controller" && app.session?.roomId) {
    rejoin();
  }
  if (mode === "worker") {
    const saved = Number(localStorage.getItem(`heimdall.lease.${app.roomId}`) || 0);
    if (saved) {
      app.leaseUntil = saved;
      app.leaseExpired = saved <= Date.now();
    }
    renderWorkerStatus();
    updateComposer();
  }
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

main();