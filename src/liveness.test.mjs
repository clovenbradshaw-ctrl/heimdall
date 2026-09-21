import test from "node:test";
import assert from "node:assert/strict";
import {
  standingOf,
  shouldRelink,
  isLive,
  isRevoked,
  revokeEntry,
  withRevoked,
  withoutRevoked,
  STALE_AFTER_MS,
  DEAD_AFTER_MS,
} from "./liveness.js";
import { isEligible } from "./route.js";

const T = 1_000_000;
const open = (over = {}) => ({ status: "ready", peer: { opened: true }, hello: { model: "m" }, lastSeen: T, ...over });

test("heard within the stale bound → ready and live", () => {
  const rec = open();
  assert.equal(standingOf(rec, T + STALE_AFTER_MS - 1), "ready");
  assert.equal(isLive(rec, T + STALE_AFTER_MS - 1), true);
  assert.equal(shouldRelink(rec, T + STALE_AFTER_MS - 1), false);
});

test("three missed pings → stale: shown, not routable, link kept", () => {
  const rec = open();
  const now = T + STALE_AFTER_MS;
  assert.equal(standingOf(rec, now), "stale");
  assert.equal(isLive(rec, now), false);
  assert.equal(shouldRelink(rec, now), false);
  assert.equal(isEligible(rec, now), false, "route.js must not pick a stale horse");
});

test("silent past the dead bound → relink", () => {
  const rec = open();
  assert.equal(standingOf(rec, T + DEAD_AFTER_MS), "dead");
  assert.equal(shouldRelink(rec, T + DEAD_AFTER_MS), true);
});

test("a ping resets the clock — a stale horse that speaks is ready again", () => {
  const rec = open();
  assert.equal(standingOf(rec, T + STALE_AFTER_MS), "stale");
  rec.lastSeen = T + STALE_AFTER_MS;
  assert.equal(standingOf(rec, T + STALE_AFTER_MS + 1), "ready");
});

test("never heard is linking, not dead — no conviction on absence of evidence", () => {
  const rec = open({ lastSeen: null, hello: null });
  assert.equal(standingOf(rec, T + DEAD_AFTER_MS * 10), "linking");
  assert.equal(shouldRelink(rec, T + DEAD_AFTER_MS * 10), false);
});

test("closed channel is lost, lapsed lease is expired, both outrank silence", () => {
  assert.equal(standingOf(open({ status: "lost" }), T), "lost");
  assert.equal(shouldRelink(open({ status: "lost" }), T), true);
  assert.equal(standingOf(open({ hello: { leaseUntil: T - 1 } }), T), "expired");
  assert.equal(standingOf(open({ peer: { opened: false } }), T), "linking");
});

test("route.js still treats an unknown lastSeen as eligible (legacy records)", () => {
  assert.equal(isEligible({ status: "ready", peer: { opened: true }, hello: {} }, T), true);
});

test("revoked: exact device, or every device of a user", () => {
  const list = withRevoked([], revokeEntry({ userId: "@a:hs", deviceId: "D1", reason: "left the team", at: T }));
  assert.equal(isRevoked(list, { userId: "@a:hs", deviceId: "D1" }), true);
  assert.equal(isRevoked(list, { userId: "@a:hs", deviceId: "D2" }), false);
  const banned = withRevoked(list, revokeEntry({ userId: "@b:hs", deviceId: null, at: T }));
  assert.equal(isRevoked(banned, { userId: "@b:hs", deviceId: "anything" }), true);
  assert.equal(isRevoked(banned, { userId: "@c:hs", deviceId: "D1" }), false);
});

test("withRevoked replaces, withoutRevoked restores — one device or the whole user", () => {
  let list = withRevoked([], revokeEntry({ userId: "@a:hs", deviceId: "D1", reason: "one", at: 1 }));
  list = withRevoked(list, revokeEntry({ userId: "@a:hs", deviceId: "D1", reason: "two", at: 2 }));
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, "two");
  list = withRevoked(list, revokeEntry({ userId: "@a:hs", deviceId: "D2", at: 3 }));
  assert.equal(withoutRevoked(list, { userId: "@a:hs", deviceId: "D1" }).length, 1);
  assert.equal(withoutRevoked(list, { userId: "@a:hs" }).length, 0);
  assert.equal(isRevoked(withoutRevoked(list, { userId: "@a:hs" }), { userId: "@a:hs", deviceId: "D2" }), false);
});

test("garbage lists never throw and never revoke", () => {
  assert.equal(isRevoked(null, { userId: "@a:hs", deviceId: "D1" }), false);
  assert.equal(isRevoked([null, {}, { userId: "@a:hs" }], { userId: "@b:hs", deviceId: "D1" }), false);
  assert.deepEqual(withoutRevoked(undefined, { userId: "@a:hs" }), []);
});
