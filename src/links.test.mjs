// links.test.mjs — the pure half of native app linking: address normalization,
// wire classification, tag guessing, link resolution, persistence round-trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeUrl, classifyProbe, guessTag, resolveLink,
  linkAdvertisedModels, upsertLink, removeLink, loadLinks, saveLinks,
} from "./links.mjs";

test("normalizeUrl: adds http, keeps https, strips path, rejects junk", () => {
  assert.equal(normalizeUrl("192.168.1.50:8080"), "http://192.168.1.50:8080");
  assert.equal(normalizeUrl("http://100.64.0.7:8000/"), "http://100.64.0.7:8000");
  assert.equal(normalizeUrl("https://phone.local:8443/v1"), "https://phone.local:8443");
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("classifyProbe: Ollama tags and OpenAI models are recognized", () => {
  assert.deepEqual(
    classifyProbe({ models: [{ name: "gemma2:2b" }, { name: "gemma2:2b" }, { name: "qwen3:4b" }] }, null),
    { kind: "ollama", models: ["gemma2:2b", "qwen3:4b"] },
  );
  assert.deepEqual(
    classifyProbe(null, { data: [{ id: "local" }] }),
    { kind: "openai", models: ["local"] },
  );
  assert.deepEqual(classifyProbe(null, null), { kind: null, models: [] });
});

test("guessTag: known families map to their Ollama tag, else a filename stem", () => {
  assert.equal(guessTag("gemma-2-2b-it-Q4_K_M.gguf"), "gemma2:2b");
  assert.equal(guessTag("Qwen2.5-0.5B-Instruct-q4f16_1-MLC"), "qwen2.5:0.5b");
  assert.equal(guessTag("Llama-3.2-3B-Instruct-q4f16_1-MLC"), "llama3.2:3b");
  assert.equal(guessTag("MyCustom-7B-Q4_K_M.gguf"), "mycustom-7b");
  assert.equal(guessTag(""), null);
});

test("resolveLink: matches by tag, by reported model, exact id, and any", () => {
  const links = [
    { name: "phone", url: "http://100.64.0.7:8000", kind: "ollama", model: "gemma-2-2b-Q4.gguf", tag: "gemma2:2b", models: ["gemma-2-2b-Q4.gguf"] },
    { name: "tab", url: "http://192.168.1.9:8080", kind: "openai", model: "local", models: ["local"] },
  ];
  assert.equal(resolveLink(links, "gemma2:2b")?.name, "phone");
  assert.equal(resolveLink(links, "GEMMA2:2B")?.name, "phone", "normalized tag matches");
  assert.equal(resolveLink(links, "gemma-2-2b-Q4.gguf")?.name, "phone");
  assert.equal(resolveLink(links, "local")?.name, "tab");
  assert.equal(resolveLink(links, "any")?.name, "phone");
  assert.equal(resolveLink(links, "nope:1b"), null);
  assert.equal(resolveLink([], "gemma2:2b"), null);
});

test("linkAdvertisedModels: tag, model, and reported models, deduped", () => {
  assert.deepEqual(
    linkAdvertisedModels({ tag: "gemma2:2b", model: "g.gguf", models: ["g.gguf", "other"] }),
    ["gemma2:2b", "g.gguf", "other"],
  );
});

test("upsert/remove + persistence round-trip in a temp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-links-"));
  const file = join(dir, "hosts.json");
  try {
    let links = upsertLink([], { name: "phone", url: "100.64.0.7:8000", tag: "gemma2:2b" });
    assert.equal(links[0].url, "http://100.64.0.7:8000");
    links = upsertLink(links, { name: "phone2", url: "http://100.64.0.7:8000", tag: "qwen3:4b" });
    assert.equal(links.length, 1, "same URL replaces, never duplicates");
    assert.equal(links[0].name, "phone2");
    links = upsertLink(links, { name: "tab", url: "192.168.1.9:8080" });
    saveLinks(links, file);
    assert.deepEqual(loadLinks(file).map((l) => l.name).sort(), ["phone2", "tab"]);
    links = removeLink(loadLinks(file), "http://100.64.0.7:8000");
    assert.equal(links.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
