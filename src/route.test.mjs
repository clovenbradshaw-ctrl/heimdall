// route.test.mjs — the bifrost router's own walls: a job lands on a giver
// loaded with the model asked for, or it lands nowhere rather than on the
// wrong model; concurrent surfaces spread by measured wait, not by luck.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickGiver, broadcastTargets, observe, markSent, isEligible, modelOf, isRoomMouth,
  mergeInflight, mergeMeanMs, electLeader, SIBLING_TTL_MS,
} from "./route.js";

const open = { opened: true };
const closed = { opened: false };
const rec = (model, extra = {}) => ({
  status: "ready",
  peer: open,
  hello: { model, leaseUntil: Date.now() + 3600_000 },
  ...extra,
});

test("a job naming a model only lands where that model is loaded", () => {
  const workers = new Map([
    ["a|1", rec("Qwen2.5-0.5B-Instruct-q4f16_1-MLC")],
    ["b|1", rec("Llama-3.2-1B-Instruct-q4f16_1-MLC")],
  ]);
  const hit = pickGiver(workers, { model: "Llama-3.2-1B-Instruct-q4f16_1-MLC" });
  assert.equal(hit.giver.key, "b|1");
  assert.equal(hit.reason, "pinned_model");
  const miss = pickGiver(workers, { model: "nope-9B" });
  assert.equal(miss.giver, null);
  assert.equal(miss.reason, "no_giver_for_model");
});

test("a job naming no model takes the shortest expected wait", () => {
  const workers = new Map([["a|1", rec("m")], ["b|1", rec("m")]]);
  // b is busy on a slow machine: a wins despite both eligible.
  const hit = pickGiver(workers, {
    inflight: { "a|1": 0, "b|1": 2 },
    meanMs: { "a|1": 1000, "b|1": 9000 },
  });
  assert.equal(hit.giver.key, "a|1");
  assert.equal(hit.reason, "shortest_expected_wait");
});

test("an unmeasured giver is tried, never starved or preferred", () => {
  const workers = new Map([["a|1", rec("m")], ["b|1", rec("m")]]);
  // a has 1 in flight at 9s; b has 1 in flight unmeasured (typical 9s):
  // tie → rotation decides, both reachable across idx.
  const first = pickGiver(workers, { inflight: { "a|1": 1, "b|1": 1 }, meanMs: { "a|1": 9000 }, idx: 0 });
  const second = pickGiver(workers, { inflight: { "a|1": 1, "b|1": 1 }, meanMs: { "a|1": 9000 }, idx: 1 });
  assert.notEqual(first.giver.key, second.giver.key);
});

test("idle fleet rotates instead of pinning the first worker", () => {
  const workers = new Map([["a|1", rec("m")], ["b|1", rec("m")], ["c|1", rec("m")]]);
  const picks = [0, 1, 2].map((idx) => pickGiver(workers, { idx }).giver.key);
  assert.deepEqual([...picks].sort(), ["a|1", "b|1", "c|1"]);
});

test("borrower never routes to itself; linking/lost/expired never route", () => {
  const workers = new Map([
    ["me|1", rec("m")],
    ["ok|1", rec("m")],
    ["linking|1", { status: "linking", peer: open, hello: null }],
    ["lost|1", { status: "lost", peer: closed, hello: null }],
    ["exp|1", rec("m", { hello: { model: "m", leaseUntil: Date.now() - 1 } })],
  ]);
  const hit = pickGiver(workers, { borrowerKey: "me|1" });
  assert.equal(hit.giver.key, "ok|1");
  const solo = pickGiver(new Map([["me|1", rec("m")]]), { borrowerKey: "me|1" });
  assert.equal(solo.giver, null);
  assert.equal(solo.reason, "no_giver_available");
});

test("the host lending its device is a giver under the same pin", () => {
  const workers = new Map([["a|1", rec("other-model")]]);
  const self = { key: "self", model: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", loaded: true };
  const hit = pickGiver(workers, { model: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", self });
  assert.equal(hit.giver.key, "self");
  const unloaded = pickGiver(workers, { self: { ...self, loaded: false } });
  assert.equal(unloaded.giver.key, "a|1");
});

test("broadcast reaches every eligible giver plus self, nothing else", () => {
  const workers = new Map([
    ["a|1", rec("m1")],
    ["b|1", rec("m2")],
    ["dead|1", { status: "lost", peer: closed, hello: null }],
  ]);
  const out = broadcastTargets(workers, { self: { key: "self", loaded: true } });
  assert.deepEqual(out.sort(), ["a|1", "b|1", "self"]);
});

test("observe: EWMA moves the mean, failures only free the slot", () => {
  let s = { inflight: { "a|1": 2 }, meanMs: { "a|1": 1000 } };
  s = observe(s, "a|1", { ms: 2000, ok: true });
  assert.equal(s.meanMs["a|1"], Math.round(0.6 * 1000 + 0.4 * 2000));
  assert.equal(s.inflight["a|1"], 1);
  const before = s.meanMs["a|1"];
  s = observe(s, "a|1", { ok: false });
  assert.equal(s.meanMs["a|1"], before);
  assert.equal(s.inflight["a|1"], 0);
  const sent = markSent({}, "a|1");
  assert.equal(sent["a|1"], 1);
  const sent2 = markSent({ "a|1": 1 }, "b|1");
  assert.deepEqual(sent2, { "a|1": 1, "b|1": 1 });
});

test("room mouths are remote Matrix work, never local givers", () => {
  assert.ok(isRoomMouth("room:@bob:hyphae.social llama3.2:latest"));
  assert.ok(!isRoomMouth("Llama-3.2-1B-Instruct-q4f16_1-MLC"));
  assert.ok(!isRoomMouth(null));
});

test("isEligible / modelOf read the record, never guess", () => {
  assert.equal(isEligible(rec("m")), true);
  assert.equal(isEligible({ status: "ready", peer: closed, hello: null }), false);
  assert.equal(modelOf(rec("m")), "m");
  assert.equal(modelOf({ status: "ready", peer: open, hello: null }), null);
});

test("worker-reported queue steers around a giver another heimdall is using", () => {
  const workers = new Map([["a|1", rec("m")], ["b|1", rec("m")]]);
  // This heimdall sees both idle; the worker reports 3 queued (sent by a
  // sibling heimdall this inflight map never saw) — b loses.
  const hit = pickGiver(workers, {
    inflight: {},
    meanMs: { "a|1": 1000, "b|1": 1000 },
    queued: { "b|1": 3 },
    idx: 0,
  });
  assert.equal(hit.giver.key, "a|1");
  // Queue with no local inflight at all still counts: quiet here, busy there.
  const hit2 = pickGiver(workers, { queued: { "a|1": 5 }, idx: 0 });
  assert.equal(hit2.giver.key, "b|1");
});

test("sibling snapshots add load, expire, and never override local pace", () => {
  const now = Date.now();
  const live = { at: now - 1000, inflight: { "a|1": 2 }, meanMs: { "b|1": 700 } };
  const dead = { at: now - SIBLING_TTL_MS - 1, inflight: { "a|1": 9 }, meanMs: { "c|1": 1 } };
  assert.deepEqual(mergeInflight({ "a|1": 1 }, [live, dead], now), { "a|1": 3 });
  assert.deepEqual(mergeInflight({ "a|1": 1 }, "garbage", now), { "a|1": 1 });
  const means = mergeMeanMs({ "a|1": 800 }, [live, dead], now);
  assert.equal(means["a|1"], 800); // local measurement wins
  assert.equal(means["b|1"], 700); // sibling fills a blind spot
  assert.ok(!("c|1" in means)); // expired snapshot teaches nothing
});

test("leader election is deterministic and display-only", () => {
  assert.equal(electLeader(["dev-b", "dev-a", "dev-b"]), "dev-a");
  assert.equal(electLeader([]), null);
});
