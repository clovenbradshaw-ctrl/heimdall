// swarm.test.mjs — one animal, many heimdalls: presence, ally mode, and
// work migration that can fail loudly but never loop or guess.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amAlly, servesOf, pruneControllers, pickForwarder,
  makeFwdJob, validFwdJob, controllerKey, FWD_TTL, CONTROLLER_TTL_MS,
} from "./swarm.js";

const QWEN = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const LLAMA = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const open = { opened: true };
const rec = (model, status = "ready") => ({ status, peer: open, hello: { model } });

test("ally mode is a fact about room ownership, never a guess", () => {
  assert.equal(amAlly({ creatorId: "@a:h", userId: "@a:h" }), false);
  assert.equal(amAlly({ creatorId: "@a:h", userId: "@b:h" }), true);
  assert.equal(amAlly({ creatorId: null, userId: "@b:h" }), false);
  assert.equal(amAlly({}), false);
});

test("serves advertises what this controller could actually serve", () => {
  const workers = new Map([["a|1", rec(QWEN)], ["b|1", rec(LLAMA)], ["dead|1", rec(QWEN, "lost")]]);
  assert.deepEqual(servesOf(workers, { key: "self", model: QWEN, loaded: true }), [LLAMA, QWEN]);
  assert.deepEqual(servesOf(workers, null), [LLAMA, QWEN]);
  assert.deepEqual(servesOf(new Map(), null), []);
});

test("stale controller sightings are gone, not quiet", () => {
  const now = Date.now();
  const map = new Map([
    ["a|x", { at: now - 1000 }],
    ["b|y", { at: now - CONTROLLER_TTL_MS - 1 }],
  ]);
  const out = pruneControllers(map, now);
  assert.ok(out.has("a|x") && !out.has("b|y"));
});

test("forwarding targets serves, skips tried, rotates the rest", () => {
  const now = Date.now();
  const controllers = new Map([
    ["cA|1", { at: now, serves: [QWEN] }],
    ["cB|1", { at: now, serves: [LLAMA] }],
    ["cC|1", { at: now - CONTROLLER_TTL_MS - 1, serves: [LLAMA] }],
  ]);
  const hit = pickForwarder(controllers, { wantModel: LLAMA });
  assert.equal(hit.forwarder.key, "cB|1");
  assert.equal(hit.reason, "forward_failover");
  const miss = pickForwarder(controllers, { wantModel: "nope-9B" });
  assert.equal(miss.forwarder, null);
  assert.equal(miss.reason, "no_sibling_serves_model");
  const skip = pickForwarder(controllers, { wantModel: LLAMA, tried: ["cB|1"] });
  assert.equal(skip.forwarder, null);
  const any1 = pickForwarder(controllers, { idx: 0, now });
  const any2 = pickForwarder(controllers, { idx: 1, now });
  assert.notEqual(any1.forwarder.key, any2.forwarder.key);
});

test("forward envelopes carry one hop and refuse replays", () => {
  const env = makeFwdJob({
    fwdId: "f1",
    from: "cA|1",
    job: { id: "j1", model: LLAMA, messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(env.ttl, FWD_TTL);
  assert.deepEqual(validFwdJob(env, []), { ok: true, reason: null });
  assert.equal(validFwdJob(env, ["f1"]).reason, "forward_replay");
  assert.equal(validFwdJob({ ...env, ttl: 0 }, []).reason, "forward_ttl_spent");
  assert.equal(validFwdJob({ kind: "fwd-job" }, []).reason, "bad_forward_shape");
  assert.equal(validFwdJob(null, []).reason, "not_a_forward");
});

test("controllerKey joins identity the way the router keys it", () => {
  assert.equal(controllerKey({ userId: "@a:h", deviceId: "d1" }), "@a:h|d1");
});
