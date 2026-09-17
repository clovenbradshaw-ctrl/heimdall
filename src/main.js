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
    renderFleet();
  } else if (msg.type === "error") {
    consolePush(msg.id, `\n[error] ${msg.message}\n`);
    rec.status = "ready";
    renderFleet();
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

let shareBoxEl, inviteExpiryEl, fleetCardEl, promptCardEl, promptEl, consoleEl;
let acceptBtnEl, statusEl, progressEl, progressFillEl, modelStatusEl, noteEl, identityEl;

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

  return el("div", { class: "view" }, [
    header(),
    el("div", { class: "card" }, [
      el("h2", { text: "Fleet" }),
      el("p", { class: "muted", text: "The link names you, carries an expiry, and makes the worker show its own IP before accepting. The room is only a directory — prompts and answers travel device-to-device over WebRTC, never through the room." }),
      el("label", { text: "your name" }),
      nameEl,
      el("div", { class: "row", style: "" }, [createBtn, freshBtn]),
      shareRow,
      inviteExpiryEl,
    ]),
    fleetCardEl,
    promptCardEl,
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
          el("div", { class: "meta", text: meta }),
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
    el("p", { class: "muted", text: `Accepting runs a small language model in this tab and makes it available to ${who}. Nothing is stored on a server; your device does the compute. The lease lasts 12 hours and must be renewed.` }),
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
  const renewBtn = app.leaseExpired || app.renewRequested
    ? el("button", { class: "primary small", text: "Renew now", onclick: acceptDuty })
    : null;
  const lines = [
    el("div", { class: "row" }, [
      el("span", { class: "badge", text: `links: ${online}` }),
      app.wakeLock ? el("span", { class: "badge ok", text: "screen awake" }) : null,
      el("span", { class: "badge", text: `model: ${app.modelId}` }),
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
  }
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

main();