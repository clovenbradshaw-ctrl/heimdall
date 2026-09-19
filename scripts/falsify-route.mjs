#!/usr/bin/env node
// falsify-route.mjs — controls built to fail against the bifrost + swarm.
//
// Every claim below is written as something that SHOULD hold. A failure is
// a real bug, not a bad test. Exit 1 on the first break.
import { pickGiver, mergeInflight, mergeMeanMs, observe, markSent } from "../src/route.js";
import { pickForwarder, validFwdJob, makeFwdJob, pruneControllers, servesOf, amAlly } from "../src/swarm.js";

let failures = 0;
const check = (cond, msg) => {
  if (!cond) { failures++; console.error("FALSIFIED:", msg); }
  else console.log("holds:", msg);
};
const rnd = (n) => Math.floor(Math.random() * n);
const MODELS = ["qwen", "llama", "smol", null];

function randomFleet() {
  const n = 1 + rnd(5);
  const m = new Map();
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    m.set(`w${i}|d`, {
      status: r < 0.7 ? "ready" : r < 0.85 ? "linking" : "lost",
      peer: r < 0.8 ? { opened: true } : { opened: false },
      hello: Math.random() < 0.9 ? { model: MODELS[rnd(3)], leaseUntil: Date.now() + 3600_000 } : null,
    });
  }
  // Occasionally expire a lease.
  for (const [, rec] of m) if (Math.random() < 0.1 && rec.hello) rec.hello.leaseUntil = Date.now() - 1;
  return m;
}
const eligible = (workers, now, borrower = null) =>
  [...workers.entries()].filter(([k, r]) =>
    k !== borrower && r.status === "ready" && r.peer?.opened &&
    !(r.hello?.leaseUntil && now > r.hello.leaseUntil));

// ── 1. fuzz: pinned jobs never land wrong, borrowers never self-serve ──
{
  let wrongModel = 0, selfRouted = 0, ineligible = 0, trials = 0;
  for (let i = 0; i < 5000; i++) {
    const workers = randomFleet();
    const keys = [...workers.keys()];
    const borrower = keys.length && Math.random() < 0.5 ? keys[rnd(keys.length)] : null;
    const want = MODELS[rnd(4)];
    const now = Date.now();
    const p = pickGiver(workers, {
      borrowerKey: borrower, model: want,
      inflight: Object.fromEntries(keys.map((k) => [k, rnd(4)])),
      meanMs: Object.fromEntries(keys.map((k) => [k, rnd(9000) + 1])),
      queued: Object.fromEntries(keys.map((k) => [k, rnd(3)])),
      idx: rnd(10), now,
    });
    trials++;
    if (!p.giver) {
      // Refusal must be honest: either nothing eligible, or nothing with the model.
      const elig = eligible(workers, now, borrower);
      if (elig.length && !want) { ineligible++; break; }
      if (want && elig.some(([, r]) => (r.hello?.model ?? null) === want)) { wrongModel++; break; }
      continue;
    }
    const rec = workers.get(p.giver.key);
    if (p.giver.key === borrower) { selfRouted++; break; }
    if (!rec || rec.status !== "ready" || !rec.peer?.opened) { ineligible++; break; }
    if (want && (rec.hello?.model ?? null) !== want) { wrongModel++; break; }
  }
  check(trials === 5000 && wrongModel === 0, `5000 fuzzed picks, zero wrong-model (${wrongModel})`);
  check(selfRouted === 0, "borrower never routes to itself");
  check(ineligible === 0, "never routes to an ineligible giver");
}

// ── 2. fuzz: unpinned pick is always among the minimal-wait set ─────────
// (ties rotate, so membership — not identity — is the invariant)
{
  let bad = 0;
  for (let i = 0; i < 3000; i++) {
    const workers = randomFleet();
    const keys = [...workers.keys()];
    const now = Date.now();
    const inflight = Object.fromEntries(keys.map((k) => [k, rnd(4)]));
    const meanMs = Object.fromEntries(keys.map((k) => [k, rnd(9000) + 1]));
    const p = pickGiver(workers, { inflight, meanMs, queued: {}, idx: rnd(10), now });
    const elig = eligible(workers, now);
    if (!elig.length) { if (p.giver !== null) { bad++; break; } continue; }
    if (!p.giver) { bad++; break; }
    // Mirror the implementation's own typical-fallback exactly.
    const timed = elig.map(([k]) => meanMs[k]).filter((v) => Number.isFinite(v) && v > 0);
    const typical = timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : 1;
    const waits = new Map(elig.map(([k]) => [k, (inflight[k] ?? 0) * (Number.isFinite(meanMs[k]) && meanMs[k] > 0 ? meanMs[k] : typical)]));
    const min = Math.min(...waits.values());
    if (waits.get(p.giver.key) !== min) { bad++; break; }
  }
  check(bad === 0, "unpinned pick always minimal-wait (ties rotate, never exceed)");
}

// ── 3. adversarial inputs: non-Map collections, garbage snapshots ───────
{
  let threw = null;
  try {
    const objWorkers = { "a|1": { status: "ready", peer: { opened: true }, hello: { model: "qwen" } } };
    const p = pickGiver(objWorkers, { model: "qwen" });
    check(p.giver?.key === "a|1", "plain-object fleet still routes");
    const f = pickForwarder(new Map(), { wantModel: "qwen" });
    check(f.forwarder === null, "empty controllers refuse loudly");
    const fo = pickForwarder({ "c|1": { at: Date.now(), serves: ["qwen"] } }, { wantModel: "qwen" });
    check(fo.forwarder?.key === "c|1", "plain-object controllers still route");
    check(mergeInflight({ a: 1 }, [{ inflight: { a: -5, b: NaN } }]).a === 1, "negative/NaN snapshot counts ignored");
    check(mergeMeanMs({}, [{ at: Date.now(), meanMs: { a: -3, b: 0 } }]).a === undefined, "non-positive pace never adopted");
    check(mergeInflight({ a: 1 }, "garbage").a === 1, "garbage snapshot ignored");
    const o = observe({ inflight: { a: 1 }, meanMs: {} }, "a", { ms: -50, ok: true });
    check(o.meanMs.a === undefined && o.inflight.a === 0, "non-positive sample frees slot, moves no mean");
    const m = markSent(undefined, "a");
    check(m.a === 1, "markSent tolerates undefined map");
  } catch (e) { threw = e; }
  check(!threw, `no throw on adversarial input${threw ? `: ${threw.message}` : ""}`);
}

// ── 4. attack the forward protocol ──────────────────────────────────────
{
  // ttl abuse
  const base = makeFwdJob({ fwdId: "x", from: "o|1", job: { id: "j", messages: [{ role: "user", content: "hi" }] } });
  check(validFwdJob({ ...base, ttl: -1 }, []).reason === "forward_ttl_spent", "negative ttl refused");
  check(validFwdJob({ ...base, ttl: 1.5 }, []).ok, "ttl is a count, fractional still positive (serves once)");
  // shape abuse
  check(validFwdJob({ kind: "fwd-job", fwdId: "x", ttl: 1, job: { id: "j", messages: "not-an-array" } }, []).reason === "bad_forward_shape", "string messages refused");
  check(validFwdJob({ kind: "fwd-job", fwdId: "x", ttl: 1, job: { id: "j", messages: [] } }, []).ok, "empty messages array is the router's problem, not the envelope's");
  // replay across seen lists
  check(validFwdJob(base, ["y", "x"]).reason === "forward_replay", "replay refused even among others");
  // forwarder rotation is bounded: tried-all returns null, never loops
  const now = Date.now();
  const ctrls = new Map([["c|1", { at: now, serves: ["qwen"] }]]);
  const r = pickForwarder(ctrls, { tried: ["c|1"], now });
  check(r.forwarder === null, "tried-everything ends, never loops");
}

// ── 5. trust boundary: cross-account serves can't buy steering ──────────
// (Pure check: merge helpers only ever read same-account snapshots by
// construction of the caller — here we verify the helpers themselves add
// nothing without a live `at`, so a forged undated snapshot is inert.)
{
  const forged = { inflight: { "a|1": 100 }, meanMs: { "a|1": 1 } }; // no `at`
  check(mergeInflight({}, [forged])["a|1"] === undefined, "undated snapshot contributes nothing");
  check(mergeMeanMs({}, [forged])["a|1"] === undefined, "undated pace contributes nothing");
}

// ── 6. ally + serves edge cases ─────────────────────────────────────────
{
  check(!amAlly({ creatorId: "@a:h", userId: "@a:h" }), "creator never ally");
  check(servesOf(new Map(), { key: "self", model: "q", loaded: false }).length === 0, "unloaded self serves nothing");
  check(servesOf(null, null).length === 0, "null fleet serves nothing");
  const pruned = pruneControllers("not-a-map", Date.now());
  check(pruned instanceof Map && pruned.size === 0, "prune tolerates non-Map");
}

if (failures) { console.error(`\n${failures} falsification(s) — the claim is broken`); process.exit(1); }
console.log("\nall falsification attempts failed to break it (good)");
