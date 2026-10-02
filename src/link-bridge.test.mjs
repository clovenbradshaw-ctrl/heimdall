// link-bridge.test.mjs — the bridge as a front door for native app hosts:
// probe + link an Ollama-shaped app, see it advertised in /api/tags and /api/ps,
// have a chat for its tag routed straight to the app, and leave everything else
// to the real Ollama untouched.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "./bridge-server.mjs";

let app, appUrl, upstream, upstreamUrl, bridge, base, tmp;
const upstreamHits = [];
let appHits = 0;

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

before(async () => {
  // a native app: Ollama's /api/tags and a streaming /api/chat
  app = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/api/tags") return json(res, 200, { models: [{ name: "gemma-2-2b-Q4.gguf" }] });
      if (req.url === "/api/chat") {
        appHits++;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ message: { role: "assistant", content: "from-" }, done: false }) + "\n");
        res.write(JSON.stringify({ message: { role: "assistant", content: "native" }, done: true }) + "\n");
        return res.end();
      }
      json(res, 404, { error: "no" });
    });
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${app.address().port}`;

  // the real Ollama behind pass-through
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      upstreamHits.push(req.url);
      if (req.url === "/api/tags") return json(res, 200, { models: [{ name: "gemma2:2b" }] });
      json(res, 200, { model: JSON.parse(body || "{}").model, message: { role: "assistant", content: "from-ollama" }, done: true });
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  tmp = mkdtempSync(join(tmpdir(), "heimdall-link-"));
  const dist = mkdtempSync(join(tmpdir(), "heimdall-dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html>");
  bridge = createBridge({ port: 0, dist, upstream: upstreamUrl, autoOpen: false, linksFile: join(tmp, "hosts.json") });
  const addr = await bridge.listen();
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await bridge.close();
  app.close();
  upstream.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("probe reports the wire and the models", async () => {
  const p = await post(`${base}/link/probe`, { url: appUrl.replace("http://", "") });
  assert.equal(p.ok, true);
  assert.equal(p.kind, "ollama");
  assert.deepEqual(p.models, ["gemma-2-2b-Q4.gguf"]);
});

test("link stores the host under the tag asked for, and a bad address is refused", async () => {
  const bad = await post(`${base}/link/host`, { url: "http://127.0.0.1:1" });
  assert.equal(bad.ok, false, "an address nothing answers is refused");
  const ok = await post(`${base}/link/host`, { url: appUrl, tag: "gemma2:2b", model: "gemma-2-2b-Q4.gguf" });
  assert.equal(ok.ok, true);
  const l = ok.links.find((x) => x.url === appUrl);
  assert.equal(l.tag, "gemma2:2b");
  assert.equal(l.kind, "ollama");
});

test("/api/tags and /api/ps advertise the native host", async () => {
  const tags = await (await fetch(`${base}/api/tags`)).json();
  assert.ok(tags.models.some((m) => m.name === "gemma2:2b" && m.heimdall?.native), "native tag advertised");
  const ps = await (await fetch(`${base}/api/ps`)).json();
  assert.ok(ps.models.some((m) => m.name === "gemma2:2b" && m.heimdall?.kind === "ollama"));
});

test("a chat for the linked tag is answered by the app, not the real Ollama", async () => {
  const before = upstreamHits.length;
  const beforeApp = appHits;
  const r = await (await fetch(`${base}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gemma2:2b", messages: [{ role: "user", content: "hi" }], stream: false }),
  })).json();
  assert.equal(r.message.content, "from-native");
  assert.equal(appHits, beforeApp + 1, "the app served it");
  assert.equal(upstreamHits.length, before, "the real Ollama was not touched");
});

test("a model no host holds still passes through", async () => {
  const before = upstreamHits.length;
  const r = await (await fetch(`${base}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "unlinked:7b", messages: [{ role: "user", content: "hi" }], stream: false }),
  })).json();
  assert.equal(r.message.content, "from-ollama");
  assert.equal(upstreamHits.length, before + 1);
});

test("removing the link takes it out of /api/tags", async () => {
  await post(`${base}/link/remove`, { url: appUrl });
  const tags = await (await fetch(`${base}/api/tags`)).json();
  assert.ok(!tags.models.some((m) => m.heimdall?.native), "no native host remains");
});
