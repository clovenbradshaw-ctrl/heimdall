// bridge-server.mjs — the fleet, seen from this computer as one more Ollama.
//
// `heimdall up` runs this. It does three things on 127.0.0.1:
//   1. serves the heimdall page (dist/), so the controller tab is same-origin
//      with the bridge and nothing crosses a CORS wall;
//   2. speaks Ollama's API (/api/chat, /api/generate, /api/tags, /api/ps,
//      /api/version) and OpenAI's (/v1/chat/completions, /v1/models), so
//      eoreader7 — or anything that takes an Ollama URL — can send inference
//      to a phone by adding one host: ER7_OLLAMA_HOSTS="…,fleet=http://localhost:8790";
//   3. carries each request to the controller tab (server-sent events down,
//      POSTs up), where the fleet's own router picks a phone, and streams the
//      tokens back in Ollama's shape.
//
// What the fleet cannot serve, it passes through to the real Ollama
// (upstream) untouched: a model no phone holds, a request with a JSON
// grammar / tools / images, no controller tab open, or a phone that fails
// before its first token (a prompt longer than the phone's window fails
// there, and is answered here instead — measured by the phone, not guessed).
// Nothing is ever answered by a different model than the one asked for.
//
// /api/ps lists only what a phone holds right now, so a caller's resident-first
// picker sees the phone as hot only for the models it truly has. The phone's
// context window is reported as `heimdall.context_window`, not `context_length`:
// eoreader7's same-shape rule exists to stop Ollama reloads, which cannot
// happen on a phone; overflow is handled by the fall-through above.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { answers, normalizeTag, ollamaTagOf } from "./models.js";

// The tab posts its state every 5 s — but a hidden tab's timers are throttled
// to about once a minute, so the bridge also pings over the open event stream
// (an event handler, which is not throttled) and the tab answers with its
// state. Fresh = heard within this long.
// The open stream itself is the liveness (the browser closes it with the
// tab); the posted state only has to be recent enough to trust its list of
// ready phones, and a throttled tab still posts once a minute.
const TAB_FRESH_MS = 5 * 60_000;
const PING_MS = 10_000;
const FIRST_TOKEN_MS = 180_000; // a phone's cold first token (model already loaded) — then fall through
const IDLE_MS = 120_000; // silence mid-stream this long ends the job

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

export function createBridge({
  port = 8790,
  host = "127.0.0.1",
  dist,
  upstream = "http://127.0.0.1:11434",
  passthrough = true,
  site = "https://clovenbradshaw-ctrl.github.io/heimdall/",
  lendModel = null,
  log = () => {},
} = {}) {
  const tabs = new Set(); // open SSE responses; the newest one is the controller
  let state = null; // last state the tab posted
  let stateAt = 0;
  const jobs = new Map(); // id -> { onMsg }
  const stats = { fleet: 0, passthrough: 0, fellThrough: 0 };
  const selfOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

  const tabAlive = () => tabs.size > 0 && Date.now() - stateAt < TAB_FRESH_MS;
  const readyWorkers = () => (tabAlive() ? (state?.workers ?? []).filter((w) => w.ready && w.model) : []);
  // `any` (or `fleet`) asks for whatever a ready phone holds — the caller
  // chose not to pin a model. Every other name is pinned exactly.
  const isAny = (model) => model === "any" || model === "fleet";
  const fleetServes = (model) => !!model && readyWorkers().some((w) => isAny(model) || answers(w.model, model));

  function toTab(msg) {
    const tab = [...tabs].at(-1);
    if (!tab) return false;
    tab.write(`data: ${JSON.stringify(msg)}\n\n`);
    return true;
  }

  /** Run one chat on the fleet. Calls onToken(text) per delta; resolves
   *  { text, ms, tokens } or rejects with { beforeFirstToken, message }. */
  function runOnFleet({ model, messages, temperature, max_tokens }, onToken) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const t0 = Date.now();
      let text = "";
      let tokens = 0;
      let timer = null;
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(null, `the fleet went quiet for ${Math.round(ms / 1000)}s`), ms);
      };
      const finish = (ok, err) => {
        clearTimeout(timer);
        jobs.delete(id);
        if (ok) resolve({ text, ms: Date.now() - t0, tokens });
        else reject({ beforeFirstToken: tokens === 0, message: err });
      };
      jobs.set(id, {
        onMsg(m) {
          if (m.type === "token") {
            if (typeof m.text !== "string" || !m.text) return;
            text += m.text;
            tokens++;
            arm(IDLE_MS);
            onToken(m.text);
          } else if (m.type === "result") {
            // a giver that did not stream still delivers its whole text
            if (!tokens && m.text) {
              text = m.text;
              tokens = 1;
              onToken(m.text);
            }
            finish(true);
          } else if (m.type === "error") {
            finish(null, m.message || "fleet error");
          }
        },
      });
      arm(FIRST_TOKEN_MS);
      if (!toTab({ type: "job", id, model: isAny(model) ? null : model, messages, temperature, max_tokens })) finish(null, "no controller tab");
    });
  }

  /* ---------------------------------------------------------- helpers */

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function json(res, code, obj) {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  async function pipeUpstream(req, res, raw, urlPath = req.url) {
    stats.passthrough++;
    if (!passthrough) {
      let model = null;
      try { model = JSON.parse(raw.toString() || "{}").model; } catch {}
      return json(res, 404, { error: `model "${model}" not found in the fleet (no phone holds it, and pass-through is off)` });
    }
    try {
      // The caller's identity and Heimdall's hop marks ride through (2026-09-21):
      // upstream is Heimdall's channel, which keys the line per SERVER and
      // must see the original caller, not the bridge; and a turn the channel
      // sent HERE that fell through must re-enter marked, never re-queue.
      const headers = { "content-type": req.headers["content-type"] || "application/json" };
      for (const [k, v] of Object.entries(req.headers)) if (/^x-(er7|heimdall)-/.test(k) && typeof v === "string") headers[k] = v;
      if (!headers["x-er7-user"] && !headers["x-er7-caller"] && !headers["x-er7-session"]) headers["x-er7-caller"] = `heimdall-bridge:${port}`;
      const r = await fetch(upstream + urlPath, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
      });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
      if (!r.body) return res.end();
      for await (const chunk of r.body) res.write(chunk);
      res.end();
    } catch (e) {
      if (!res.headersSent) json(res, 502, { error: `upstream Ollama at ${upstream} did not answer: ${e.message}` });
      else res.end();
    }
  }

  const tagDetails = (webllmId) => ({
    parent_model: "",
    format: "mlc",
    family: (ollamaTagOf(webllmId) || webllmId).split(":")[0],
    families: [(ollamaTagOf(webllmId) || webllmId).split(":")[0]],
    parameter_size: (ollamaTagOf(webllmId) || "").split(":")[1]?.toUpperCase() ?? "",
    quantization_level: /q4f32/.test(webllmId) ? "q4f32_1" : "q4f16_1",
  });

  /** One entry per model the fleet can serve now (both names offered). */
  function fleetModels() {
    const seen = new Map();
    for (const w of readyWorkers()) {
      const tag = ollamaTagOf(w.model);
      for (const name of [tag, w.model].filter(Boolean)) {
        const cur = seen.get(name);
        if (cur) { cur.heimdall.workers++; continue; }
        seen.set(name, {
          name,
          model: name,
          modified_at: new Date(stateAt).toISOString(),
          size: 0,
          digest: "",
          details: tagDetails(w.model),
          heimdall: { webllm: w.model, workers: 1, context_window: w.ctx ?? null },
        });
      }
    }
    return [...seen.values()];
  }

  const chatMessagesOf = (b) => {
    if (Array.isArray(b.messages)) return b.messages.map((m) => ({ role: m.role, content: String(m.content ?? "") }));
    const out = [];
    if (b.system) out.push({ role: "system", content: String(b.system) });
    if (b.prompt != null) out.push({ role: "user", content: String(b.prompt) });
    return out;
  };

  const fleetCanTake = (b) =>
    !b.format && !(b.tools?.length) && !b.images?.length &&
    !(Array.isArray(b.messages) && b.messages.some((m) => m.images?.length || m.tool_calls)) &&
    fleetServes(b.model);

  /* -------------------------------------------- Ollama: chat + generate */

  async function ollamaRun(req, res, raw, kind) {
    let b;
    try { b = JSON.parse(raw.toString() || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
    const messages = chatMessagesOf(b);
    const hasPrompt = messages.some((m) => m.content.trim());
    // A load / keep-alive call (no prompt): answered at once when a phone holds the model.
    if (!hasPrompt) {
      if (!fleetServes(b.model)) return pipeUpstream(req, res, raw);
      const done = { model: b.model, created_at: new Date().toISOString(), done: true, done_reason: "load" };
      return json(res, 200, kind === "chat" ? { ...done, message: { role: "assistant", content: "" } } : { ...done, response: "" });
    }
    if (!fleetCanTake(b)) return pipeUpstream(req, res, raw);

    const stream = b.stream !== false;
    const opts = b.options || {};
    const line = (delta, extra = {}) => ({
      model: b.model,
      created_at: new Date().toISOString(),
      ...(kind === "chat" ? { message: { role: "assistant", content: delta } } : { response: delta }),
      done: false,
      ...extra,
    });
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      if (stream) res.writeHead(200, { "content-type": "application/x-ndjson" });
    };
    try {
      const out = await runOnFleet(
        { model: b.model, messages, temperature: opts.temperature ?? 0.7, max_tokens: opts.num_predict > 0 ? opts.num_predict : 1024 },
        (delta) => {
          start();
          if (stream) res.write(JSON.stringify(line(delta)) + "\n");
        },
      );
      stats.fleet++;
      const ns = out.ms * 1e6;
      const final = { ...line(stream ? "" : out.text), done: true, done_reason: "stop", total_duration: ns, load_duration: 0, eval_count: out.tokens, eval_duration: ns, heimdall: "fleet" };
      if (stream) { start(); res.end(JSON.stringify(final) + "\n"); }
      else json(res, 200, final);
      log(`fleet  ${b.model}  ${out.tokens} chunks  ${out.ms}ms`);
    } catch (e) {
      if (e?.beforeFirstToken && !started) {
        // Nothing reached the caller yet: answer from the real Ollama instead.
        stats.fellThrough++;
        log(`fleet  ${b.model}  failed before first token (${e.message}) — passing through`);
        return pipeUpstream(req, res, raw);
      }
      log(`fleet  ${b.model}  failed mid-stream: ${e?.message}`);
      if (stream) { start(); res.end(JSON.stringify({ error: e?.message || "fleet error" }) + "\n"); }
      else json(res, 502, { error: e?.message || "fleet error" });
    }
  }

  /* ------------------------------------------------ OpenAI: chat/completions */

  async function openaiChat(req, res, raw) {
    let b;
    try { b = JSON.parse(raw.toString() || "{}"); } catch { return json(res, 400, { error: { message: "invalid JSON" } }); }
    if (b.response_format || b.tools?.length || !fleetServes(b.model)) return pipeUpstream(req, res, raw);
    const messages = (b.messages || []).map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("") }));
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null) => ({ id, object: "chat.completion.chunk", created, model: b.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    let started = false;
    const start = () => {
      if (started || !b.stream) return;
      started = true;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }))}\n\n`);
    };
    try {
      const out = await runOnFleet(
        { model: b.model, messages, temperature: b.temperature ?? 0.7, max_tokens: b.max_tokens ?? b.max_completion_tokens ?? 1024 },
        (delta) => { start(); if (b.stream) res.write(`data: ${JSON.stringify(chunk({ content: delta }))}\n\n`); },
      );
      stats.fleet++;
      if (b.stream) {
        start();
        res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        json(res, 200, { id, object: "chat.completion", created, model: b.model, choices: [{ index: 0, message: { role: "assistant", content: out.text }, finish_reason: "stop" }], usage: { completion_tokens: out.tokens } });
      }
    } catch (e) {
      if (e?.beforeFirstToken && !started) { stats.fellThrough++; return pipeUpstream(req, res, raw); }
      if (b.stream) { start(); res.end(`data: ${JSON.stringify({ error: { message: e?.message } })}\n\n`); }
      else json(res, 502, { error: { message: e?.message || "fleet error" } });
    }
  }

  /* ---------------------------------------------------------- static */

  function serveStatic(req, res) {
    const u = new URL(req.url, "http://x");
    let p = decodeURIComponent(u.pathname);
    if (p === "/" || p === "") p = "/index.html";
    const file = path.normalize(path.join(dist, p));
    if (!file.startsWith(path.normalize(dist))) return json(res, 403, { error: "forbidden" });
    fs.readFile(file, (err, data) => {
      if (err) {
        if (p.includes(".")) return json(res, 404, { error: "not found" });
        return fs.readFile(path.join(dist, "index.html"), (e2, idx) => {
          if (e2) return json(res, 500, { error: "dist/index.html missing — run npm run build" });
          res.writeHead(200, { "content-type": TYPES[".html"] });
          res.end(idx);
        });
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": p === "/index.html" || p.endsWith("sw.js") ? "no-cache" : "public, max-age=3600" });
      res.end(data);
    });
  }

  /* ---------------------------------------------------------- router */

  const server = http.createServer(async (req, res) => {
    // Only this page and origin-less local clients (eoreader7, curl) may
    // talk to the bridge — the same rule Ollama applies to browsers.
    const origin = req.headers.origin;
    if (origin && !selfOrigins.has(origin)) return json(res, 403, { error: `origin ${origin} not allowed` });
    const u = new URL(req.url, "http://x");
    const route = `${req.method} ${u.pathname}`;
    try {
      switch (route) {
        case "GET /bridge/hello":
          return json(res, 200, { bridge: true, site, upstream, passthrough, lendModel, port });
        case "GET /bridge/events": {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(": heimdall bridge\n\n");
          tabs.add(res);
          const ka = setInterval(() => res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`), PING_MS);
          req.on("close", () => { clearInterval(ka); tabs.delete(res); });
          log(`controller tab connected (${tabs.size} open)`);
          return;
        }
        case "POST /bridge/state": {
          state = JSON.parse((await readBody(req)).toString() || "{}");
          stateAt = Date.now();
          return json(res, 200, { ok: true });
        }
        case "POST /bridge/reply": {
          const batch = JSON.parse((await readBody(req)).toString() || "[]");
          for (const m of Array.isArray(batch) ? batch : [batch]) jobs.get(m?.id)?.onMsg(m);
          return json(res, 200, { ok: true });
        }
        case "GET /bridge/upstream/tags":
          return pipeUpstream(req, res, Buffer.alloc(0), "/api/tags");
        case "POST /bridge/upstream/chat":
          return pipeUpstream(req, res, await readBody(req), "/api/chat");
        case "GET /status":
          return json(res, 200, { tab: tabAlive(), room: state?.room ?? null, workers: state?.workers ?? [], lending: state?.self ?? null, stats, upstream, passthrough, diag: state?.diag ?? {}, hostRecv: state?.hostRecv ?? [] });
        case "GET /api/version":
          return json(res, 200, { version: "0.0.0-heimdall-bridge" });
        case "GET /api/ps":
          return json(res, 200, { models: fleetModels().map((m) => ({ ...m, size_vram: 0, expires_at: new Date(Date.now() + TAB_FRESH_MS).toISOString() })) });
        case "GET /api/tags": {
          const fleet = fleetModels();
          let up = [];
          if (passthrough) {
            try { up = (await (await fetch(upstream + "/api/tags", { signal: AbortSignal.timeout(3000) })).json()).models ?? []; } catch {}
          }
          const names = new Set(fleet.map((m) => m.name));
          return json(res, 200, { models: [...fleet, ...up.filter((m) => !names.has(m.name))] });
        }
        case "POST /api/chat":
          return ollamaRun(req, res, await readBody(req), "chat");
        case "POST /api/generate":
          return ollamaRun(req, res, await readBody(req), "generate");
        case "POST /v1/chat/completions":
          return openaiChat(req, res, await readBody(req));
        case "GET /v1/models":
          return json(res, 200, { object: "list", data: fleetModels().map((m) => ({ id: m.name, object: "model", owned_by: "heimdall-fleet" })) });
        default:
          if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/v1/")) return pipeUpstream(req, res, await readBody(req));
          if (req.method === "GET") return serveStatic(req, res);
          return json(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String(e?.message || e) });
      else res.end();
    }
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(server.address())); }),
    close: () => new Promise((r) => { for (const t of tabs) t.end(); server.close(() => r()); }),
    stats,
    fleetServes,
    normalizeTag,
  };
}
