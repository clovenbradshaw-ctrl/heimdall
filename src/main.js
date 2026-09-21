import "./style.css";
import {
  MatrixPeer,
  login,
  registerAuto,
  randomUsername,
  shareUrl,
  parseShareUrl,
  deviceKey,
  sha256Hex,
} from "./matrix.js";
import { RtcPeer } from "./rtc.js";
import { WorkerEngine, MODEL_CHOICES, DEFAULT_MODEL, webgpuAvailable } from "./llm.js";
import { pickGiver as routePickGiver, observe as routeObserve, markSent as routeMarkSent, isRoomMouth, mergeInflight, mergeMeanMs, electLeader, SIBLING_TTL_MS } from "./route.js";
import { amAlly, servesOf, pruneControllers, pickForwarder, makeFwdJob, validFwdJob, controllerKey, CONTROLLER_TTL_MS, FWD_TTL } from "./swarm.js";
import { el, statusDot, copyBtn, toast, deviceName, publicIp, countdownText } from "./ui.js";
import {
  generateDeviceKeyPair,
  importPrivateKeyJwk,
  codeFromPublicKey,
  signText,
  pairingPayload,
  issueCode,
  confirmCode,
  consumeCode,
  importPublicKeyB64,
  verifyText,
  recordPairedKey,
} from "./invite.js";

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
  leaseUntil: 0,
  leaseExpired: false,
  renewRequested: false,
  myIp: null,
  timers: [],
  pendingVerify: null,
  ledger: new Map(), // deviceKey -> { give, borrow }
  relay: new Map(), // job id -> { giverKey, borrowerKey, borrowerRec, t0, model }
  runs: new Map(), // broadcast run id -> { rootEl, headEl, streams: Map(wkey -> stream rec) }
  route: { inflight: {}, meanMs: {}, idx: 0 }, // bifrost evidence: measured wait per giver
  siblings: new Map(), // same-account heimdall deviceKey -> { at, deviceId, inflight, meanMs }
  controllers: new Map(), // every announced heimdall deviceKey -> { at, deviceId, userId, serves, sameAccount }
  coordPeers: new Map(), // sibling deviceKey -> { peer, device, status }
  fwdRelay: new Map(), // fwdId -> origin- or servant-side forward state
  seenFwd: [], // fwdIds already served here — replays refused
  fwdIdx: 0, // rotation counter for forward targeting
  presenceTick: 0, // reconcile counter — hello broadcast every 3rd tick
  giverIdx: 0, // legacy counter, kept for broadcast rotation symmetry
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
    // Keep the generated password so the owner can later prove ownership and
    // claim the account with a real password (see claimCard / doClaim).
    saveSession({ creds: { ...creds, password } });
  }
  const cryptoPrefix = "heimdall::" + creds.userId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const matrix = new MatrixPeer({
    ...creds,
    cryptoPrefix,
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

async function onSignal(senderUserId, content) {
  // Sibling heimdall load snapshots (same account, another surface). Only
  // the account's own devices are trusted for steering — a worker or a
  // stranger's controller could otherwise inflate load and steer the fleet.
  // Cross-account coordination rides on worker-reported queueDepth instead,
  // which the worker itself authenticates over its own link.
  if (content.type === "coord" && mode === "controller") {
    if (!app.matrix || senderUserId !== app.matrix.userId) return;
    if (!content.deviceId || content.deviceId === app.matrix.deviceId) return;
    app.siblings.set(deviceKey({ userId: senderUserId, deviceId: content.deviceId }), {
      at: content.at || Date.now(),
      deviceId: content.deviceId,
      inflight: content.inflight || {},
      meanMs: content.meanMs || {},
    });
    renderFleet();
    return;
  }
  // Another heimdall announcing itself (any account) or heartbeating.
  // Recorded for the organism view and forward targeting. Load snapshots
  // that STEER routing are still same-account only (see "coord" above) —
  // a stranger's serves list only ever attracts a forward it must then
  // actually serve, and every forward carries its own timeout.
  if ((content.type === "hello-controller" || content.type === "coord-heartbeat") && mode === "controller") {
    if (!app.matrix || !content.deviceId) return;
    if (String(content.deviceId) === String(app.matrix.deviceId) && senderUserId === app.matrix.userId) return;
    app.controllers.set(deviceKey({ userId: senderUserId, deviceId: content.deviceId }), {
      at: content.at || Date.now(),
      deviceId: content.deviceId,
      userId: senderUserId,
      serves: Array.isArray(content.serves) ? content.serves.filter((m) => typeof m === "string") : [],
      sameAccount: senderUserId === app.matrix.userId,
    });
    renderFleet();
    return;
  }
  if (content.type === "signal") {
    const key = deviceKey({ userId: senderUserId, deviceId: content.deviceId });
    if (mode === "controller") {
      // A sibling heimdall's WebRTC signal rides the same to-device type:
      // coord peers first (the organism's nerves), workers after.
      const coord = app.coordPeers.get(key);
      if (coord?.peer) {
        coord.peer.handleSignal(content.label, content.data).catch(() => {});
        return;
      }
      if (app.controllers.has(key)) {
        ensureCoordLink({ userId: senderUserId, deviceId: content.deviceId }, true)
          .then((peer) => peer.handleSignal(content.label, content.data).catch(() => {}));
        return;
      }
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
  } else if (content.type === "verify" && mode === "controller") {
    // The worker proves the pairing. We verify the whole chain before
    // confirming — nothing can be faked without the private key:
    //   1. the presented code hash was actually recorded by us,
    //   2. that code is the fingerprint of the presented PUBLIC key,
    //   3. the signature is valid under that public key, over room+identity+code.
    let ok = false;
    try {
      if (app.session?.creds) {
        const creds = app.session.creds;
        const recorded = await confirmCode({ creds, codeHash: content.codeHash });
        if (recorded && content.pubKey && content.sig) {
          const pubKey = await importPublicKeyB64(content.pubKey);
          const fingerprint = await codeFromPublicKey(content.pubKey);
          const fpMatches = (await sha256Hex(fingerprint)) === content.codeHash;
          const payload = pairingPayload(app.roomId, senderUserId, content.deviceId, content.codeHash);
          const sigOk = await verifyText(pubKey, payload, content.sig);
          ok = fpMatches && sigOk;
          if (ok) {
            consumeCode({ creds, codeHash: content.codeHash }).catch(() => {});
            recordPairedKey({ creds, userId: senderUserId, deviceId: content.deviceId, pubKey: content.pubKey }).catch(() => {});
          }
        }
      }
    } catch {}
    const device = { userId: senderUserId, deviceId: content.deviceId };
    app.matrix
      ?.sendSignalRetry(device, { type: ok ? "verified" : "denied", deviceId: app.matrix.deviceId }, 3)
      .then(() => {});
    if (ok) toast(`paired ${senderUserId} — signature + code verified`);
    else toast(`pairing refused for ${senderUserId} — code, key, or signature didn't check out`);
  } else if (content.type === "verified" && mode === "worker") {
    if (app.creatorId && senderUserId !== app.creatorId) return;
    if (app.pendingVerify) {
      const r = app.pendingVerify;
      app.pendingVerify = null;
      r(true);
    }
  } else if (content.type === "denied" && mode === "worker") {
    if (app.creatorId && senderUserId !== app.creatorId) return;
    if (app.pendingVerify) {
      const r = app.pendingVerify;
      app.pendingVerify = null;
      r(false);
    }
  }
}

/* ------------------------------------------------------------ controller */

async function buildInviteUrl() {
  const name = app.displayName || app.matrix.userId;
  const exp = Date.now() + INVITE_TTL;
  app.invite = { name, exp };
  saveSession({ invite: app.invite });
  const base = shareUrl(app.roomId, app.hs);
  // The 6-digit pairing code is generated on the WORKER's device and given to
  // you out of band; you record it to onboard them. It never rides in the link.
  return `${base}&host=${encodeURIComponent(app.matrix.userId)}&name=${encodeURIComponent(name)}&exp=${exp}`;
}

async function renewInvite() {
  // Renewed consent: a fresh link, same room, fresh expiry.
  await refreshShareBox();
  toast("new link issued — share it with your worker");
}

async function refreshShareBox() {
  if (!shareBoxEl || !app.roomId) return;
  shareBoxEl.value = await buildInviteUrl();
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
  // Ally mode: this room belongs to another account, so its workers will
  // never answer our offers (they serve their creator's devices only).
  // Don't storm them — contribute the lent device, accept forwards.
  const ally = amAlly({ creatorId: app.matrix.roomCreator(), userId: app.matrix.userId });
  app.ally = ally;
  if (!ally) {
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
  presenceHeartbeat();
}

/** The organism's pulse. Every tick: prune the quiet, share load snapshots
 *  with same-account siblings (trusted steering), heartbeat serves to every
 *  announced controller, and every 3rd tick broadcast hello-controller to
 *  the whole room so allied accounts can find us. All best-effort, one
 *  attempt — the next 15s tick sends it again. */
async function siblingHeartbeat() {
  return presenceHeartbeat();
}

async function presenceHeartbeat() {
  if (mode !== "controller" || !app.matrix) return;
  const now = Date.now();
  for (const [key, snap] of app.siblings) {
    if (now - snap.at > SIBLING_TTL_MS) app.siblings.delete(key);
  }
  app.controllers = pruneControllers(app.controllers, now);
  const serves = servesOf(app.workers, selfGiver());
  // Same-account siblings: full load snapshots (shared steering).
  try {
    const own = await app.matrix.devicesOf(app.matrix.userId, { retry: 0 });
    const snap = {
      type: "coord",
      deviceId: app.matrix.deviceId,
      at: now,
      inflight: app.route.inflight,
      meanMs: app.route.meanMs,
      serves,
    };
    for (const d of own) {
      if (String(d.deviceId) === String(app.matrix.deviceId)) continue;
      app.matrix.sendSignalRetry(d, snap, 1).then(() => {});
    }
  } catch { /* presence is best-effort */ }
  // Announced controllers (any account): serves heartbeat.
  const beat = { type: "coord-heartbeat", deviceId: app.matrix.deviceId, at: now, serves };
  for (const [, c] of app.controllers) {
    app.matrix.sendSignalRetry({ userId: c.userId, deviceId: c.deviceId }, beat, 1).then(() => {});
  }
  // Whole room, every 3rd tick: hello so unknown allies can find us.
  // Workers ignore unknown to-device types, so this noise costs them nothing.
  app.presenceTick++;
  if (app.presenceTick % 3 === 0) {
    const hello = { type: "hello-controller", deviceId: app.matrix.deviceId, at: now, serves };
    try {
      for (const userId of app.matrix.roomMembers()) {
        const devs = await app.matrix.devicesOf(userId, { retry: 0 });
        for (const d of devs) app.matrix.sendSignalRetry(d, hello, 1).then(() => {});
      }
    } catch { /* presence is best-effort */ }
  }
  renderFleet();
}

/** What the router sees: own measurements plus live sibling snapshots, and
 *  worker-reported queue depth (jobs other heimdalls — any account — sent
 *  that no local map can see). */
function effectiveLoad() {
  const snaps = [...app.siblings.values()];
  return {
    inflight: mergeInflight(app.route.inflight, snaps),
    meanMs: mergeMeanMs(app.route.meanMs, snaps),
  };
}

/** Worker-reported queue depth per giver key, plus the host's own engine. */
function queuedLoad() {
  const out = {};
  for (const [key, rec] of app.workers) {
    if (Number.isFinite(rec.queueDepth) && rec.queueDepth > 0) out[key] = rec.queueDepth;
  }
  const selfPending = app.hubEngine?.pending ?? 0;
  if (selfPending > 0) out.self = selfPending;
  return out;
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

function selfGiver() {
  if (app.lendDevice && app.hubEngine?.loaded) {
    return { key: "self", model: app.hubEngine.modelId || app.modelId, loaded: true };
  }
  return null;
}

function noteObserved(giverKey, ms, ok) {
  const next = routeObserve(app.route, giverKey, { ms, ok });
  app.route.inflight = next.inflight;
  app.route.meanMs = next.meanMs;
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
    clearTimeout(r.timer);
    noteObserved(r.giverKey, Date.now() - r.t0, msg.type === "result");
    // A model-mismatch error is the router's own failure to avoid — never
    // settle credit on it, so a misrouted job doesn't mint borrow debt.
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
    rec.queueDepth = Number.isFinite(msg.queueDepth) && msg.queueDepth > 0 ? msg.queueDepth : 0;
    renderFleet();
  } else if (msg.type === "lease") {
    rec.hello = { ...(rec.hello || {}), leaseUntil: msg.until };
    rec.renewed = true;
    rec.status = "ready";
    rec.lastSeen = Date.now();
    if (Number.isFinite(msg.queueDepth)) rec.queueDepth = Math.max(0, msg.queueDepth);
    renderFleet();
  } else if (msg.type === "ping") {
    rec.lastSeen = Date.now();
    // Backpressure + model freshness from the worker itself: what the
    // worker reports queued covers jobs sibling heimdalls sent that no
    // local inflight map can see. A cross-account heimdall coordinates
    // through exactly this number.
    if (Number.isFinite(msg.queueDepth)) rec.queueDepth = Math.max(0, msg.queueDepth);
    if (msg.model && rec.hello) rec.hello.model = msg.model;
  } else if (msg.type === "token") {
    // A broadcast run's tokens land in the worker's own stream block, so
    // "run on all" stays readable instead of one interleaved soup.
    pushRunToken(msg.id, key, msg.text);
  } else if (msg.type === "result") {
    finishRunStream(msg.id, key, `[done ${msg.duration_ms}ms]`, true);
    rec.lastSeen = Date.now();
    noteObserved(key, msg.duration_ms ?? null, true);
    // The hub borrowed from this worker — it gave compute. Credit it.
    const l = app.ledger.get(key) || { give: 0, borrow: 0 };
    l.give++;
    app.ledger.set(key, l);
    pushCredit(key, l);
    renderFleet();
  } else if (msg.type === "error") {
    finishRunStream(msg.id, key, `[error] ${msg.message}`, false);
    // A model_mismatch here means the broadcast label drifted or the
    // worker swapped models mid-lease — free the slot, keep the mean.
    noteObserved(key, null, false);
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

const JOB_TIMEOUT_MS = 120_000;

function onBorrowJob(borrowerKey, rec, msg) {
  const l = ledgerOf(borrowerKey);
  if (l.borrow >= l.give) {
    rec.peer.send({ type: "error", id: msg.id, message: "no credit — you have to give compute before you can borrow. Serve a job first." });
    return;
  }
  const wantModel = msg.model ?? null;
  // A remote Matrix mouth is never served by a local WebLLM giver. Route
  // it down the Matrix path instead of quietly answering with the wrong
  // model — the-fold's pinned-model rule, one level down.
  if (wantModel && isRoomMouth(wantModel)) {
    rec.peer.send({ type: "error", id: msg.id, message: "remote Matrix mouth — not routable to local workers" });
    return;
  }
  const eff = effectiveLoad();
  const picked = routePickGiver(app.workers, {
    borrowerKey,
    model: wantModel,
    self: selfGiver(),
    inflight: eff.inflight,
    meanMs: eff.meanMs,
    queued: queuedLoad(),
    idx: app.route.idx++,
  });
  if (!picked.giver) {
    // No local giver — the organism migrates the work, not the refusal.
    // Offer it to a sibling that advertises the model; only when nobody
    // can serve does the borrower hear "no".
    forwardJobToSibling(borrowerKey, rec, msg, wantModel, picked.reason).catch(() => {
      rec.peer?.send?.({
        type: "error",
        id: msg.id,
        message: picked.reason === "no_giver_for_model"
          ? `no giver loaded with ${wantModel} right now`
          : "no giver available right now",
      });
    });
    return;
  }
  const giver = picked.giver;
  const req = {
    type: "infer",
    id: msg.id,
    model: wantModel,
    messages: msg.messages || [{ role: "user", content: msg.prompt }],
    stream: true,
    temperature: msg.temperature ?? 0.7,
    max_tokens: msg.max_tokens ?? 1024,
  };
  app.route.inflight = routeMarkSent(app.route.inflight, giver.key);
  const t0 = Date.now();
  const timer = setTimeout(() => {
    if (!app.relay.has(msg.id)) return;
    app.relay.delete(msg.id);
    noteObserved(giver.key, null, false);
    rec.peer?.send?.({ type: "error", id: msg.id, message: "giver timed out — try again" });
    renderFleet();
  }, JOB_TIMEOUT_MS);
  app.relay.set(msg.id, { giverKey: giver.key, borrowerKey, borrowerRec: rec, t0, model: wantModel, timer });
  if (giver.key === "self") {
    serveSelf(req, rec);
  } else {
    giver.rec.peer.send(req);
  }
}

function pickGiver(borrowerKey, model = null) {
  const eff = effectiveLoad();
  const picked = routePickGiver(app.workers, {
    borrowerKey,
    model,
    self: selfGiver(),
    inflight: eff.inflight,
    meanMs: eff.meanMs,
    queued: queuedLoad(),
    idx: app.route.idx++,
  });
  return picked.giver;
}

async function serveSelf(req, borrowerRec) {
  const t0 = Date.now();
  try {
    // The host's own device is a giver under the same pin: a job naming a
    // model it isn't loaded with is refused, never silently answered.
    const loaded = app.hubEngine?.modelId || app.modelId;
    if (req.model && req.model !== loaded) {
      throw new Error(`model_mismatch: host loaded with ${loaded}, job asked for ${req.model}`);
    }
    const { text } = await app.hubEngine.infer(
      req.messages,
      { stream: true, temperature: req.temperature, max_tokens: req.max_tokens },
      (delta) => borrowerRec.peer?.send({ type: "token", id: req.id, text: delta }),
    );
    const r = app.relay.get(req.id);
    if (r) clearTimeout(r.timer);
    app.relay.delete(req.id);
    noteObserved("self", Date.now() - t0, true);
    settle("self", r?.borrowerKey || "");
    borrowerRec.peer?.send({ type: "result", id: req.id, text, duration_ms: Date.now() - t0 });
  } catch (e) {
    const r = app.relay.get(req.id);
    if (r) clearTimeout(r.timer);
    app.relay.delete(req.id);
    noteObserved("self", Date.now() - t0, false);
    borrowerRec.peer?.send({ type: "error", id: req.id, message: String(e?.message || e) });
  }
}

/* ------------------------------------------- the organism's nerves ----
   Controller-to-controller DataChannels: work migrates over these when one
   heimdall has no local giver. RtcPeer is reused whole — a coord peer is a
   worker peer pointed at a sibling, speaking fwd-* envelopes instead of
   infer. Timeouts keep every migration loud: a link that won't open in
   15s, a job unanswered in 120s, both fail the borrower with words. */

const COORD_OPEN_MS = 15_000;

function coordSend(siblingKey, msg) {
  const c = app.coordPeers.get(siblingKey);
  if (c?.peer?.opened) {
    c.peer.send(msg);
    return true;
  }
  return false;
}

/** Open (or reuse) the coord link to a sibling controller. Inbound offers
 *  (inbound=true, from onSignal) only bind the peer — the offer itself is
 *  handled by the caller right after. */
function ensureCoordLink(device, inbound = false) {
  const key = controllerKey(device);
  const existing = app.coordPeers.get(key);
  // One link per sibling: concurrent forwards share the pending open
  // instead of orphaning duplicate peers.
  if (existing?.peer) {
    if (existing.peer.opened) return Promise.resolve(existing.peer);
    if (existing.opening) return existing.opening;
  }
  const entry = { device, peer: null, status: "linking", opening: null };
  const opening = new Promise((resolve, reject) => {
    const peer = new RtcPeer({
      signal: (label, data) =>
        app.matrix
          .sendSignalRetry(device, { type: "signal", deviceId: app.matrix.deviceId, label, data })
          .then(() => {}),
      onOpen: () => {
        entry.status = "open";
        renderFleet();
        resolve(peer);
      },
      onClose: () => {
        entry.status = "lost";
        renderFleet();
        setTimeout(() => {
          if (app.coordPeers.get(key) === entry) app.coordPeers.delete(key);
        }, 5000);
      },
      onMessage: (cmsg) => onCoordMessage(key, device, cmsg),
    });
    entry.peer = peer;
    app.coordPeers.set(key, entry);
    renderFleet();
    if (!inbound) {
      peer.offer().catch((e) => {
        app.coordPeers.delete(key);
        reject(e);
      });
      setTimeout(() => {
        if (!peer.opened) {
          app.coordPeers.delete(key);
          reject(new Error("coord link timed out"));
        }
      }, COORD_OPEN_MS);
    } else {
      // Inbound: the offer arrives via onSignal right after — resolve now
      // so the caller can handle it; if nothing ever comes, reap the husk.
      resolve(peer);
      setTimeout(() => {
        if (!peer.opened && app.coordPeers.get(key) === entry) app.coordPeers.delete(key);
      }, COORD_OPEN_MS);
    }
  });
  entry.opening = opening;
  opening.then(
    () => { entry.opening = null; },
    () => { if (app.coordPeers.get(key)?.opening === opening) app.coordPeers.delete(key); },
  );
  return opening;
}

/** Migrate a borrow no local giver could serve. Tries each able sibling
 *  once (tried-list, huginn's discipline); the first open link that takes
 *  the job wins. Rejects when nobody can — the caller then fails loudly. */
async function forwardJobToSibling(borrowerKey, borrowerRec, msg, wantModel) {
  const tried = [];
  for (;;) {
    const { forwarder } = pickForwarder(app.controllers, {
      wantModel,
      tried,
      idx: app.fwdIdx++,
    });
    if (!forwarder) throw new Error("no sibling can serve");
    tried.push(forwarder.key);
    const device = { userId: forwarder.rec.userId, deviceId: forwarder.rec.deviceId };
    let peer;
    try {
      peer = await ensureCoordLink(device);
      if (!peer.opened) throw new Error("coord link not open");
    } catch {
      continue; // this sibling unreachable — try the next, never stall
    }
    const fwdId = crypto.randomUUID();
    const env = makeFwdJob({
      fwdId,
      from: controllerKey({ userId: app.matrix.userId, deviceId: app.matrix.deviceId }),
      job: {
        id: msg.id,
        model: wantModel,
        messages: msg.messages || [{ role: "user", content: msg.prompt }],
        temperature: msg.temperature ?? 0.7,
        max_tokens: msg.max_tokens ?? 1024,
      },
    });
    const t0 = Date.now();
    const timer = setTimeout(() => {
      if (!app.fwdRelay.has(fwdId)) return;
      app.fwdRelay.delete(fwdId);
      noteObserved(forwarder.key, null, false);
      borrowerRec.peer?.send?.({ type: "error", id: msg.id, message: "sibling heimdall timed out — try again" });
      renderFleet();
    }, JOB_TIMEOUT_MS);
    app.fwdRelay.set(fwdId, { borrowerKey, borrowerRec, siblingKey: forwarder.key, t0, timer, jobId: msg.id });
    app.route.inflight = routeMarkSent(app.route.inflight, forwarder.key);
    peer.send(env);
    return; // handed off — tokens/results land in onCoordMessage
  }
}

/** One hop's far end. fwd-job is SERVED here (never re-forwarded — ttl 1),
 *  fwd-token/result/error continue a job we originated. */
function onCoordMessage(siblingKey, siblingDevice, cmsg) {
  if (!cmsg || typeof cmsg !== "object") return;
  if (cmsg.kind === "fwd-job") {
    serveForwarded(siblingKey, cmsg);
    return;
  }
  const st = app.fwdRelay.get(cmsg.fwdId);
  if (!st) return;
  if (cmsg.kind === "fwd-token") {
    if (st.borrowerRec?.peer?.opened) st.borrowerRec.peer.send({ type: "token", id: st.jobId, text: cmsg.text });
  } else if (cmsg.kind === "fwd-result" || cmsg.kind === "fwd-error") {
    app.fwdRelay.delete(cmsg.fwdId);
    clearTimeout(st.timer);
    // Per-hop settlement: the sibling earned with us, the borrower owes us.
    // Symmetric with every direct route — the organism keeps no central
    // wallet, each link settles its own.
    noteObserved(st.siblingKey, Date.now() - st.t0, cmsg.kind === "fwd-result");
    if (cmsg.kind === "fwd-result") settle(st.siblingKey, st.borrowerKey);
    if (st.borrowerRec?.peer?.opened) {
      st.borrowerRec.peer.send(
        cmsg.kind === "fwd-result"
          ? { type: "result", id: st.jobId, text: cmsg.text, duration_ms: cmsg.duration_ms }
          : { type: "error", id: st.jobId, message: cmsg.message },
      );
    }
    renderFleet();
  }
}

/** Serve a sibling's forwarded job from LOCAL givers only. The sibling is
 *  the borrower of record: settlement and credit flow through the existing
 *  relay path unchanged, via a virtual borrowerRec that speaks fwd-*
 *  back over the coord link. */
function serveForwarded(siblingKey, env) {
  const fail = (message) => coordSend(siblingKey, { kind: "fwd-error", fwdId: env.fwdId, id: env.job?.id, message });
  const v = validFwdJob(env, app.seenFwd);
  if (!v.ok) {
    if (v.reason !== "forward_replay") fail(`refused forward: ${v.reason}`);
    return;
  }
  app.seenFwd.push(env.fwdId);
  if (app.seenFwd.length > 500) app.seenFwd.splice(0, app.seenFwd.length - 500);
  // Same job.id twice (an origin retry after its own timeout, while we still
  // serve the first): refuse rather than overwrite the live relay entry,
  // which would let the first timer kill the second job.
  if (app.relay.has(env.job.id)) {
    fail("already serving that job here — dedupe by job id");
    return;
  }
  const wantModel = env.job.model ?? null;
  if (wantModel && isRoomMouth(wantModel)) {
    fail("remote Matrix mouth — not routable to local workers");
    return;
  }
  const eff = effectiveLoad();
  const picked = routePickGiver(app.workers, {
    borrowerKey: siblingKey, // a sibling is never its own giver
    model: wantModel,
    self: selfGiver(),
    inflight: eff.inflight,
    meanMs: eff.meanMs,
    queued: queuedLoad(),
    idx: app.route.idx++,
  });
  if (!picked.giver) {
    fail(picked.reason === "no_giver_for_model" ? `no giver loaded with ${wantModel} here` : "no giver available here");
    return;
  }
  const giver = picked.giver;
  // Virtual borrower: the relay path settles (giver ↔ sibling) and pushes
  // credit exactly as for a direct borrow; only the last mile differs.
  const virtualRec = {
    peer: {
      opened: true,
      send: (m) => {
        if (m.type === "token") coordSend(siblingKey, { kind: "fwd-token", fwdId: env.fwdId, id: env.job.id, text: m.text });
        else if (m.type === "result") coordSend(siblingKey, { kind: "fwd-result", fwdId: env.fwdId, id: env.job.id, text: m.text, duration_ms: m.duration_ms });
        else if (m.type === "error") coordSend(siblingKey, { kind: "fwd-error", fwdId: env.fwdId, id: env.job.id, message: m.message });
      },
    },
  };
  const req = {
    type: "infer",
    id: env.job.id,
    model: wantModel,
    messages: env.job.messages,
    stream: true,
    temperature: env.job.temperature ?? 0.7,
    max_tokens: env.job.max_tokens ?? 1024,
  };
  app.route.inflight = routeMarkSent(app.route.inflight, giver.key);
  const t0 = Date.now();
  const timer = setTimeout(() => {
    if (!app.relay.has(req.id)) return;
    app.relay.delete(req.id);
    noteObserved(giver.key, null, false);
    fail("giver timed out — try again");
    renderFleet();
  }, JOB_TIMEOUT_MS);
  app.relay.set(req.id, { giverKey: giver.key, borrowerKey: siblingKey, borrowerRec: virtualRec, t0, model: wantModel, timer });
  if (giver.key === "self") serveSelf(req, virtualRec);
  else giver.rec.peer.send(req);
}

function nudgeRenew(key) {
  const rec = app.workers.get(key);
  if (rec?.peer?.opened) rec.peer.send({ type: "renew" });
}

function sendInferAll() {
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  const id = crypto.randomUUID();
  const run = beginRun(id, prompt);
  // A broadcast fans out to every eligible giver (each model answers in
  // its own voice — that IS the experiment). Per-target inflight is
  // tracked so the next borrowed job sees the real load.
  let sent = 0;
  for (const [wkey, rec] of app.workers) {
    if (rec.peer?.opened && rec.status !== "expired" && !(rec.hello?.leaseUntil && Date.now() > rec.hello.leaseUntil)) {
      rec.peer.send({
        type: "infer",
        id,
        model: rec.hello?.model ?? null, // labelled, so a mismatch is visible, never silent
        messages: [{ role: "user", content: prompt }],
        stream: true,
        temperature: 0.7,
        max_tokens: 1024,
      });
      app.route.inflight = routeMarkSent(app.route.inflight, wkey);
      openRunStream(id, wkey, rec.hello?.name || rec.device.userId, rec.hello?.model ?? null);
      sent++;
    }
  }
  const self = selfGiver();
  if (self) {
    openRunStream(id, "self", "you (this device)", self.model);
    const req = {
      type: "infer",
      id: `self:${id}`,
      model: self.model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      temperature: 0.7,
      max_tokens: 1024,
    };
    app.route.inflight = routeMarkSent(app.route.inflight, "self");
    const t0 = Date.now();
    app.hubEngine
      .infer(req.messages, { stream: true, temperature: 0.7, max_tokens: 1024 }, (d) => pushRunToken(id, "self", d))
      .then(({ text }) => {
        noteObserved("self", Date.now() - t0, true);
        finishRunStream(id, "self", `[done ${Date.now() - t0}ms]`, true);
      })
      .catch((e) => {
        noteObserved("self", Date.now() - t0, false);
        finishRunStream(id, "self", `[error] ${e?.message || e}`, false);
      });
    sent++;
  }
  if (!sent) {
    run.headEl.append(el("span", { class: "muted", text: " — no live workers connected" }));
    endRun(id);
    toast("no live workers connected");
  }
}

/* -------------------------------------------------------- run streams */

/** Every broadcast run gets a group: a muted prompt header, then one
 *  streaming block per giver. Tokens land in the block for the worker that
 *  sent them — a live cursor marks the one still writing. */
function beginRun(id, prompt) {
  const run = { id, streams: new Map() };
  const rootEl = el("div", { class: "run" });
  const headEl = el("div", { class: "run-head", text: `▶ ${prompt}` });
  run.rootEl = rootEl;
  run.headEl = headEl;
  rootEl.append(headEl);
  streamsEl.append(rootEl);
  app.runs.set(id, run);
  streamsEl.scrollTop = streamsEl.scrollHeight;
  return run;
}

function openRunStream(runId, wkey, label, model) {
  const run = app.runs.get(runId);
  if (!run) return null;
  const existing = run.streams.get(wkey);
  if (existing) return existing;
  const head = el("div", { class: "stream-head" }, [
    statusDot("busy", "streaming"),
    el("span", { class: "name", text: label }),
    model ? el("span", { class: "badge", text: model }) : null,
    el("span", { class: "status", text: "streaming…" }),
  ]);
  const body = el("div", { class: "stream-body" });
  const caret = el("span", { class: "caret", text: "▌" });
  body.append(caret);
  const stream = el("div", { class: "stream" }, [head, body]);
  run.rootEl.append(stream);
  const rec = { stream, head, body, caret };
  run.streams.set(wkey, rec);
  streamsEl.scrollTop = streamsEl.scrollHeight;
  return rec;
}

function pushRunToken(runId, wkey, text) {
  const run = app.runs.get(runId);
  const rec = run?.streams.get(wkey);
  if (!rec) return;
  // Insert ahead of the caret so the cursor always rides the latest token.
  rec.caret.insertAdjacentText("beforebegin", text);
  streamsEl.scrollTop = streamsEl.scrollHeight;
}

function finishRunStream(runId, wkey, note, ok) {
  const run = app.runs.get(runId);
  const rec = run?.streams.get(wkey);
  if (!rec) return;
  rec.stream.classList.add("done");
  rec.stream.classList.add(ok ? "ok" : "err");
  rec.caret.remove();
  rec.body.append(el("div", { class: "run-note", text: note }));
  const dot = rec.stream.querySelector(".dot");
  if (dot) dot.className = `dot ${ok ? "dot-ok" : "dot-err"}`;
  const status = rec.stream.querySelector(".status");
  if (status) status.textContent = ok ? "done" : "failed";
  streamsEl.scrollTop = streamsEl.scrollHeight;
  let open = 0;
  for (const [, s] of run.streams) if (!s.stream.classList.contains("done")) open++;
  if (open === 0) endRun(runId);
}

function endRun(runId) {
  app.runs.delete(runId);
}

function clearRuns() {
  app.runs.clear();
  streamsEl.textContent = "";
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
  // The pairing is cryptographic. Your device holds an ECDSA keypair; the
  // 6-digit code is a fingerprint of its PUBLIC KEY, and you prove the pairing
  // by signing it with the PRIVATE KEY. The host records the code you give
  // them, then verifies: recorded code ⟷ key fingerprint ⟷ valid signature.
  const verifiedFlag = localStorage.getItem(`heimdall.verified.${app.roomId}`) === "1";
  if (!verifiedFlag) {
    await ensureDeviceKeys();
    if (!/^\d{6}$/.test(app.pairCode || "")) {
      toast("waiting for your device code…");
      return;
    }
  }
  acceptBtnEl.disabled = true;
  acceptBtnEl.textContent = "Joining…";
  try {
    const matrix = await ensureMatrix();
    await matrix.joinRoom(app.roomId);
    app.creatorId = matrix.roomCreator();
    renderIdentity();

    // Hard consent gate: the identity claimed on the link must actually own
    // the room. Otherwise a forged link+code could route a device into a
    // stranger's fleet while impersonating the intended host.
    if (share.host && app.creatorId !== share.host) {
      reenableAccept();
      statusEl.textContent = `blocked: the room belongs to ${app.creatorId}, not ${share.host}`;
      toast("refused — this link impersonates the host");
      return;
    }

    if (!verifiedFlag) {
      // Prove the pairing: fingerprint code + signed payload to the host.
      const codeHash = await sha256Hex(app.pairCode);
      const payload = pairingPayload(app.roomId, matrix.userId, matrix.deviceId, codeHash);
      const sig = await signText(app.pairPriv, payload);
      const confirmed = await hostConfirmCode(matrix, codeHash, app.pairPub, sig);
      if (!confirmed) {
        reenableAccept();
        statusEl.textContent = "blocked: the host didn't confirm your code";
        toast("the host didn't confirm your code — they may be offline, or the code is wrong");
        return;
      }
      // Confirmed once by the host on this device → lease renewals don't re-ask.
      localStorage.setItem(`heimdall.verified.${app.roomId}`, "1");
    }

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
      if (peer.opened) peer.send({ type: "lease", until: app.leaseUntil, queueDepth: app.engine?.pending ?? 0 });
    }
    statusEl.textContent = `Standing by until ${countdownText(app.leaseUntil)}`;
    acceptBtnEl.textContent = "Renew compute duties";

    await announceReady();
    setInterval(() => announceReady(), 20000);
    setInterval(() => {
      for (const peer of app.peers.values()) {
        if (peer.opened) {
          peer.send({
            type: "ping",
            t: Date.now(),
            queueDepth: app.engine?.pending ?? 0,
            model: app.engine?.modelId || app.modelId,
          });
        }
      }
    }, 15000);
    await keepAwake();
    renderWorkerStatus();
    toast("you are compute now. keep this tab open.");
  } catch (e) {
    reenableAccept();
    statusEl.textContent = `failed: ${e.message}`;
    toast(`accept failed: ${e.message}`);
  }
}

function reenableAccept() {
  acceptBtnEl.disabled = false;
  acceptBtnEl.textContent = localStorage.getItem(`heimdall.verified.${app.roomId}`) === "1"
    ? "Renew compute duties"
    : "Accept compute duties";
}

/** The device's persistent ECDSA keypair; the pairing code is its fingerprint. */
async function ensureDeviceKeys() {
  const key = `heimdall.keys.${app.roomId}`;
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(key) || "null");
  } catch {}
  if (stored?.pub && stored?.priv) {
    app.pairPub = stored.pub;
    app.pairPriv = await importPrivateKeyJwk(stored.priv);
    app.pairCode = await codeFromPublicKey(stored.pub);
    return;
  }
  const fresh = await generateDeviceKeyPair();
  localStorage.setItem(key, JSON.stringify({ pub: fresh.pubB64, priv: fresh.privJwk }));
  app.pairPub = fresh.pubB64;
  app.pairPriv = fresh.privateKey;
  app.pairCode = await codeFromPublicKey(fresh.pubB64);
}

/** Send the signed pairing proof to the host and wait for confirmation. */
function hostConfirmCode(matrix, codeHash, pubKey, sig) {
  return new Promise((resolve) => {
    app.pendingVerify = resolve;
    const timer = setTimeout(() => {
      if (app.pendingVerify) {
        app.pendingVerify = null;
        resolve(false);
      }
    }, 25000);
    matrix
      .devicesOf(app.creatorId, { retry: 3 })
      .then((devs) => {
        if (!devs.length) {
          clearTimeout(timer);
          app.pendingVerify = null;
          resolve(false);
          return;
        }
        for (const d of devs) {
          matrix
            .sendSignalRetry(d, { type: "verify", deviceId: matrix.deviceId, codeHash, pubKey, sig }, 3)
            .catch(() => {});
        }
      })
      .catch(() => {
        clearTimeout(timer);
        app.pendingVerify = null;
        resolve(false);
      });
  });
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
        model: app.engine?.modelId || app.modelId, // the weights actually loaded, never the picker alone
        queueDepth: app.engine?.pending ?? 0,
        name: deviceName(),
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
        model: app.engine?.modelId || app.modelId, // the weights actually loaded, never the picker alone
        queueDepth: app.engine?.pending ?? 0,
        name: deviceName(),
        ua: navigator.userAgent,
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
  // Model pin, enforced at the edge: a job naming a model this device
  // isn't loaded with is refused loudly, never answered with the wrong
  // weights. The router should have avoided this; this is the wall behind
  // that wall.
  if (msg.model && msg.model !== app.modelId) {
    peer.send({ type: "error", id: msg.id, message: `model_mismatch: loaded with ${app.modelId}, job asked for ${msg.model}` });
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
  // model: null = any giver (shortest expected wait). A surface that needs
  // a specific model sets it to that exact WebLLM id and the router pins it.
  peer.send({ type: "job", id: crypto.randomUUID(), prompt, model: null, temperature: 0.7, max_tokens: 1024 });
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

let shareBoxEl, inviteExpiryEl, fleetCardEl, promptCardEl, promptEl, streamsEl, lendBtnEl, lendStatusEl;
let acceptBtnEl, statusEl, progressEl, progressFillEl, modelStatusEl, codeEl, identityEl, borrowEl, borrowBtnEl, borrowHintEl, workerConsoleEl;

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
    el("button", { class: "ghost small", text: "renew link", onclick: renewInvite }),
  ]);

  // The worker generates the pairing code on their device and gives it to you
  // out of band. You record it here to onboard them; it never rides in the link.
  const workerCodeEl = el("input", { placeholder: "6-digit code a worker gave you", inputmode: "numeric" });
  const recordBtn = el("button", {
    class: "primary",
    text: "Record",
    onclick: async () => {
      const code = workerCodeEl.value.trim();
      if (!/^\d{6}$/.test(code)) {
        toast("enter the 6-digit code your worker gave you");
        return;
      }
      if (!app.session?.creds) {
        toast("not signed in yet — create or rejoin a fleet first");
        return;
      }
      try {
        await issueCode({ creds: app.session.creds, code, exp: Date.now() + INVITE_TTL });
        workerCodeEl.value = "";
        toast(`recorded ${code} — that worker can accept now`);
      } catch (e) {
        toast(`could not record: ${e.message}`);
      }
    },
  });
  const codeRow = el("div", { class: "linkbox" }, [
    workerCodeEl,
    recordBtn,
    el("span", { class: "muted small", text: "their code → you record it → they accept" }),
  ]);

  const cliCmd = "npx --yes github:clovenbradshaw-ctrl/heimdall invite";
  const cliRow = el("div", { class: "row" }, [
    el("span", { class: "muted small", text: "or mint the link from any terminal / the fold:" }),
    el("code", { text: cliCmd }),
    copyBtn("copy", () => cliCmd),
  ]);

  const createBtn = el("button", {
    class: "primary",
    text: app.session?.roomId ? "Rejoin last fleet" : "Create fleet room",
    onclick: () => (app.session?.roomId ? rejoin() : createRoom()),
  });
  const freshBtn = el("button", { class: "ghost", text: "New room", onclick: createRoom });

  fleetCardEl = el("div", { class: "card", hidden: true }, [
    el("h2", { text: "Workers" }),
    el("div", { class: "muted small", id: "siblings" }),
    el("ul", { class: "fleet", id: "fleet" }),
  ]);

  promptEl = el("textarea", { placeholder: "send a prompt to every connected worker…" });
  streamsEl = el("div", { class: "streams" });
  promptCardEl = el("div", { class: "card", hidden: true }, [
    el("h2", { text: "Run" }),
    promptEl,
    el("div", { class: "row" }, [
      el("button", { class: "primary", text: "Run on all workers", onclick: sendInferAll }),
      el("button", { class: "ghost small", text: "clear log", onclick: clearRuns }),
    ]),
    streamsEl,
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
      el("p", { class: "muted", text: "The link names you, carries an expiry, and a secret code the worker must enter to accept. The room is only a directory — prompts and answers travel device-to-device over WebRTC, never through the room. Everyone who borrows must first give." }),
      el("label", { text: "your name" }),
      nameEl,
      el("div", { class: "row", style: "" }, [createBtn, freshBtn]),
      shareRow,
      codeRow,
      cliRow,
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
  // The organism view: every heimdall here is one animal. Same-account
  // siblings merge load signal; allied accounts migrate work over coord
  // links. Routing stays independent — no leader, no central queue — so
  // this line is awareness, never control.
  const sibEl = document.getElementById("siblings");
  if (sibEl && app.matrix) {
    const now = Date.now();
    const ctrls = [...app.controllers.entries()].filter(([, c]) => now - c.at <= CONTROLLER_TTL_MS);
    const parts = [];
    if (app.ally) parts.push("ally mode — this room belongs to another account; contributing compute, accepting forwards");
    if (ctrls.length) {
      const ids = [String(app.matrix.deviceId), ...ctrls.map(([, c]) => String(c.deviceId)).filter(Boolean)];
      const leader = electLeader(ids);
      const allies = ctrls.filter(([, c]) => !c.sameAccount).length;
      parts.push(`${ctrls.length + 1} heimdalls, one animal${allies ? ` (${allies} allied)` : ""} — display led by ${leader === String(app.matrix.deviceId) ? "you" : leader}`);
    } else if (!app.ally) {
      parts.push("sole heimdall on this fleet");
    }
    const coordOpen = [...app.coordPeers.values()].filter((c) => c.peer?.opened).length;
    if (coordOpen) parts.push(`${coordOpen} coord link${coordOpen > 1 ? "s" : ""} open`);
    sibEl.textContent = parts.join(" · ");
  }
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
    const queue = rec.queueDepth ? ` · queued ${rec.queueDepth}` : "";
    const pace = app.route.meanMs[key] ? ` · ~${Math.round(app.route.meanMs[key] / 100) / 10}s avg` : "";
    const meta = h ? `${h.model || ""}${queue}${pace}` : `linking…`;
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

  const verifiedFlag = localStorage.getItem(`heimdall.verified.${app.roomId}`) === "1";
  const pairBox = el("div", { class: "alert warn" });
  if (!verifiedFlag) {
    // Load the device keypair and show its fingerprint code.
    ensureDeviceKeys()
      .then(() => {
        if (!app.pairCode) return;
        pairBox.replaceChildren(
          el("div", { class: "row" }, [
            el("span", { text: "Your code (fingerprint of this device's key): " }),
            el("span", { class: "kbd", text: app.pairCode }),
            copyBtn("copy", () => app.pairCode),
          ]),
          el("div", { class: "muted small", text: "Send this code to the host out of band. When you accept, this device proves it with its private key — the code alone can't be faked." }),
        );
        if (codeEl) codeEl.value = app.pairCode;
      })
      .catch(() => {
        pairBox.textContent = "could not create this device's key";
      });
  }

  codeEl = el("input", {
    placeholder: "6-digit code",
    inputmode: "numeric",
    readonly: verifiedFlag ? true : "",
    autocomplete: "off",
    oninput: (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
    },
  });

  const acceptCard = el("div", { class: "card" });
  acceptBtnEl = el("button", {
    class: "primary big",
    text: verifiedFlag ? "Renew compute duties" : "Accept compute duties",
    onclick: acceptDuty,
  });
  progressEl = el("div", { class: "progress", hidden: true });
  progressFillEl = el("div");
  progressEl.append(progressFillEl);

  const expLine = el("div", {
    class: "muted small",
    text: share.exp ? `this invite ${countdownText(share.exp)}` : "no expiry set on this link — treat it with care",
  });
  const codeLine = el("div", {
    class: "alert " + (verifiedFlag ? "ok" : "warn"),
    text: verifiedFlag
      ? "This device is already paired for this room — renewals skip the proof."
      : "Your code is the fingerprint of this device's key, and it is confirmed live by the host with a signature — a stolen link or a leaked code alone can't fake the pairing.",
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
    pairBox,
    codeLine,
    el("label", { text: verifiedFlag ? "already paired" : "your device code" }),
    codeEl,
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