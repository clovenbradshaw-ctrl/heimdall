// bridge.test.mjs — the local bridge against a fake Ollama and a fake
// controller tab. Proves: a phone's model is served from the fleet in
// Ollama's own stream shape; everything the fleet can't serve reaches the
// real Ollama untouched; a phone failing before its first token falls
// through; no foreign web origin can drive the bridge.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "./bridge-server.mjs";
import { answers, normalizeTag, ollamaTagOf } from "./models.js";

let upstream, upstreamUrl, bridge, base, tab;
const upstreamHits = [];

// What the fake tab does with each job: "stream" | "fail" | "fail-late"
let tabMode = "stream";

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      upstreamHits.push({ url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "gemma2:2b" }, { name: "qwen3:4b" }] }));
      res.end(JSON.stringify({ model: JSON.parse(body || "{}").model, message: { role: "assistant", content: "from-ollama" }, done: true }) + "\n");
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  const dist = mkdtempSync(join(tmpdir(), "heimdall-dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>heimdall</title>");
  bridge = createBridge({ port: 0, dist, upstream: upstreamUrl, lendModel: "gemma2:2b" });
  const addr = await bridge.listen();
  base = `http://127.0.0.1:${addr.port}`;

  // the fake controller tab: SSE down, POSTs up
  tab = await openTab();
  await post("/bridge/state", {
    at: Date.now(),
    room: "!r:hs",
    workers: [
      { key: "@p:hs|PHONE", name: "iPhone", model: "gemma-2-2b-it-q4f16_1-MLC", ctx: 4096, standing: "ready", ready: true },
      { key: "@q:hs|STALE", name: "old", model: "Qwen3-4B-q4f16_1-MLC", standing: "stale", ready: false },
    ],
  });
});

after(async () => {
  tab?.close();
  await bridge.close();
  upstream.close();
});

function post(path, body, headers = {}) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function openTab() {
  const ctrl = new AbortController();
  const res = await fetch(base + "/bridge/events", { signal: ctrl.signal });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const job = JSON.parse(data.slice(6));
          if (job.type !== "job") continue;
          if (tabMode === "fail") {
            await post("/bridge/reply", [{ type: "error", id: job.id, message: "prompt exceeds context window" }]);
          } else {
            const toks = ["Hel", "lo ", "phone"];
            for (const t of toks) await post("/bridge/reply", [{ type: "token", id: job.id, text: t }]);
            if (tabMode === "fail-late") await post("/bridge/reply", [{ type: "error", id: job.id, message: "tab closed" }]);
            else await post("/bridge/reply", [{ type: "result", id: job.id, text: toks.join(""), duration_ms: 5 }]);
          }
        }
      }
    } catch {}
  })();
  return { close: () => ctrl.abort() };
}

const ndjson = async (res) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

test("models: one model, two names — exact or mapped, never a near miss", () => {
  assert.equal(ollamaTagOf("gemma-2-2b-it-q4f16_1-MLC"), "gemma2:2b");
  assert.ok(answers("gemma-2-2b-it-q4f32_1-MLC", "gemma2:2b"));
  assert.ok(answers("Llama-3.2-3B-Instruct-q4f16_1-MLC", "llama3.2"));
  assert.ok(answers("Llama-3.2-3B-Instruct-q4f16_1-MLC", "llama3.2:latest"));
  assert.ok(!answers("Llama-3.2-1B-Instruct-q4f16_1-MLC", "llama3.2"));
  assert.ok(!answers("gemma-2-2b-it-q4f16_1-MLC", "gemma2:9b"));
  assert.ok(!answers("gemma-2-2b-it-q4f16_1-MLC", "gemma2"));
  assert.ok(answers("Qwen3-4B-q4f16_1-MLC", "Qwen3-4B-q4f16_1-MLC"));
  assert.equal(normalizeTag("GEMMA2:2B"), "gemma2:2b");
});

test("/api/ps lists only what a ready phone holds, without context_length", async () => {
  const ps = await (await fetch(base + "/api/ps")).json();
  const names = ps.models.map((m) => m.name);
  assert.ok(names.includes("gemma2:2b"));
  assert.ok(!names.includes("qwen3:4b"), "a stale phone is not resident");
  const g = ps.models.find((m) => m.name === "gemma2:2b");
  assert.equal(g.context_length, undefined);
  assert.equal(g.heimdall.context_window, 4096);
  assert.ok(Date.parse(g.expires_at) > Date.now());
});

test("/api/tags = fleet models plus upstream's", async () => {
  const tags = await (await fetch(base + "/api/tags")).json();
  const names = tags.models.map((m) => m.name);
  assert.ok(names.includes("gemma2:2b") && names.includes("qwen3:4b"));
  assert.equal(names.filter((n) => n === "gemma2:2b").length, 1);
});

test("/api/chat on a phone's model streams from the fleet in Ollama's shape", async () => {
  tabMode = "stream";
  const hits = upstreamHits.length;
  const lines = await ndjson(await post("/api/chat", { model: "gemma2:2b", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(lines.slice(0, -1).map((l) => l.message.content).join(""), "Hello phone");
  const last = lines.at(-1);
  assert.equal(last.done, true);
  assert.equal(last.done_reason, "stop");
  assert.equal(last.heimdall, "fleet");
  assert.ok(Number.isFinite(last.total_duration));
  assert.equal(upstreamHits.length, hits, "upstream never touched");
});

test("stream:false returns one JSON with the whole text", async () => {
  tabMode = "stream";
  const j = await (await post("/api/chat", { model: "gemma2:2b", stream: false, messages: [{ role: "user", content: "hi" }] })).json();
  assert.equal(j.message.content, "Hello phone");
  assert.equal(j.done, true);
});

test("/api/generate maps prompt → response", async () => {
  tabMode = "stream";
  const lines = await ndjson(await post("/api/generate", { model: "gemma2:2b", prompt: "hi" }));
  assert.equal(lines.slice(0, -1).map((l) => l.response).join(""), "Hello phone");
});

test("a model no phone holds passes through to Ollama untouched", async () => {
  const hits = upstreamHits.length;
  const lines = await ndjson(await post("/api/chat", { model: "qwen3:4b", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(lines[0].message.content, "from-ollama");
  assert.equal(upstreamHits.length, hits + 1);
  assert.equal(JSON.parse(upstreamHits.at(-1).body).model, "qwen3:4b");
});

test("a JSON-format request passes through (the fleet does not enforce grammars)", async () => {
  const hits = upstreamHits.length;
  await ndjson(await post("/api/chat", { model: "gemma2:2b", format: "json", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(upstreamHits.length, hits + 1);
});

test("a phone failing before its first token falls through to Ollama", async () => {
  tabMode = "fail";
  const hits = upstreamHits.length;
  const lines = await ndjson(await post("/api/chat", { model: "gemma2:2b", messages: [{ role: "user", content: "long" }] }));
  assert.equal(lines[0].message.content, "from-ollama");
  assert.equal(upstreamHits.length, hits + 1);
  tabMode = "stream";
});

test("a phone failing mid-stream ends with an error line, never a silent swap", async () => {
  tabMode = "fail-late";
  const hits = upstreamHits.length;
  const lines = await ndjson(await post("/api/chat", { model: "gemma2:2b", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(lines.at(-1).error, "tab closed");
  assert.equal(upstreamHits.length, hits);
  tabMode = "stream";
});

test("a load call (no prompt) for a phone's model is answered at once", async () => {
  const j = await (await post("/api/generate", { model: "gemma2:2b", keep_alive: "1h" })).json();
  assert.equal(j.done_reason, "load");
});

test("OpenAI streaming chat works against the fleet", async () => {
  tabMode = "stream";
  const text = await (await post("/v1/chat/completions", { model: "gemma2:2b", stream: true, messages: [{ role: "user", content: "hi" }] })).text();
  const chunks = text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  assert.equal(chunks.map((c) => c.choices[0].delta.content || "").join(""), "Hello phone");
  assert.ok(text.trim().endsWith("data: [DONE]"));
});

test("a foreign web origin is refused; the page's own origin and origin-less callers are not", async () => {
  const bad = await post("/bridge/state", { workers: [] }, { origin: "https://evil.example" });
  assert.equal(bad.status, 403);
  const badChat = await post("/api/chat", { model: "gemma2:2b", messages: [] }, { origin: "https://evil.example" });
  assert.equal(badChat.status, 403);
  const hello = await (await fetch(base + "/bridge/hello")).json();
  assert.equal(hello.bridge, true);
  assert.equal(hello.lendModel, "gemma2:2b");
});

test("the page is served, with an index fallback for app routes", async () => {
  const r = await fetch(base + "/");
  assert.match(await r.text(), /heimdall/);
  const r2 = await fetch(base + "/some/route");
  assert.equal(r2.status, 200);
});

test("with no fresh tab state, nothing is promised", async () => {
  // a tab that stopped posting state is not a fleet
  await post("/bridge/state", { at: Date.now(), workers: [] });
  const ps = await (await fetch(base + "/api/ps")).json();
  assert.equal(ps.models.length, 0);
  const hits = upstreamHits.length;
  await ndjson(await post("/api/chat", { model: "gemma2:2b", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(upstreamHits.length, hits + 1);
});
