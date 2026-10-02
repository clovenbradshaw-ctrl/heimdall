// short.test.mjs — the short-invite pieces: a room's short local alias is the
// code a person types on a worker's computer, so the link is `?r=<code>`.
// The parse branch is tested against a stubbed `location`; the builders are
// pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shortCode, SHORT_ALPHABET, SHORT_LENGTH, hostOf, aliasTaken } from "./matrix.js";
import { buildShortUrl, buildInviteUrl, DEFAULT_HS } from "./invite.js";
import { parseShareUrl } from "./matrix.js";

const SITE = "https://clovenbradshaw-ctrl.github.io/heimdall/";

test("shortCode: SHORT_LENGTH chars, all from the no-confusion alphabet", () => {
  for (let i = 0; i < 200; i++) {
    const c = shortCode();
    assert.equal(c.length, SHORT_LENGTH);
    for (const ch of c) assert.ok(SHORT_ALPHABET.includes(ch), `${ch} not in alphabet`);
  }
});

test("hostOf: names the homeserver a code's alias lives on", () => {
  assert.equal(hostOf("https://hyphae.social"), "hyphae.social");
  assert.equal(hostOf("https://synapse.example.com:8448"), "synapse.example.com:8448");
  assert.equal(hostOf(""), "");
});

test("aliasTaken: an M_IN_USE (or 'in use') error is the one expected collision", () => {
  assert.equal(aliasTaken({ errcode: "M_IN_USE" }), true);
  assert.equal(aliasTaken({ message: "Alias is already in use" }), true);
  assert.equal(aliasTaken({ message: "Room alias already taken" }), true);
  assert.equal(aliasTaken({ errcode: "M_FORBIDDEN", message: "no permission" }), false);
  assert.equal(aliasTaken(new Error("network down")), false);
});

test("buildShortUrl: `?r=<code>` on the default homeserver, `&hs=` only off it", () => {
  const u = buildShortUrl({ site: SITE, code: "h7q2x", baseUrl: DEFAULT_HS });
  const parsed = new URL(u);
  assert.equal(parsed.origin + parsed.pathname, SITE);
  assert.equal(parsed.searchParams.get("r"), "h7q2x");
  assert.equal(parsed.searchParams.get("hs"), null, "default homeserver is not named");
  const off = buildShortUrl({ site: SITE, code: "h7q2x", baseUrl: "https://elsewhere.example" });
  assert.equal(new URL(off).searchParams.get("hs"), "https://elsewhere.example");
});

test("buildShortUrl strips a query from a site that already carries one", () => {
  const u = buildShortUrl({ site: SITE + "?room=x", code: "h7q2x", baseUrl: DEFAULT_HS });
  assert.equal(new URL(u).origin + new URL(u).pathname, SITE);
  assert.equal(new URL(u).searchParams.get("r"), "h7q2x");
});

test("parseShareUrl: `?r=<code>` is a short invite (no room, no host, no expiry)", () => {
  const prev = globalThis.location;
  globalThis.location = { search: `?r=h7q2x` };
  try {
    const share = parseShareUrl(DEFAULT_HS);
    assert.ok(share);
    assert.equal(share.shortCode, "h7q2x");
    assert.equal(share.roomId, undefined);
    assert.equal(share.host, "");
    assert.equal(share.exp, 0);
    assert.equal(share.key, "");
    assert.equal(share.baseUrl, DEFAULT_HS);
  } finally {
    globalThis.location = prev;
  }
});

test("parseShareUrl: an explicit `&hs=` on a short link wins over the default", () => {
  const prev = globalThis.location;
  globalThis.location = { search: `?r=h7q2x&hs=https%3A%2F%2Felsewhere.example` };
  try {
    assert.equal(parseShareUrl(DEFAULT_HS).baseUrl, "https://elsewhere.example");
  } finally {
    globalThis.location = prev;
  }
});

test("parseShareUrl: a bad code or no short param is null", () => {
  const prev = globalThis.location;
  for (const search of ["?r=", "?r=zz!", "?r=a", "?room=!abc:hs&hs=https://hs"]) {
    globalThis.location = { search };
    const share = parseShareUrl(DEFAULT_HS);
    if (search.startsWith("?room")) {
      assert.equal(share.shortCode, undefined);
      assert.equal(share.roomId, "!abc:hs");
    } else {
      assert.equal(share, null, search);
    }
  }
  globalThis.location = prev;
});

test("the full invite offers the app page; the short form stays the site root", () => {
  const full = buildInviteUrl({ site: SITE, roomId: "!abc:hs", baseUrl: DEFAULT_HS, host: "@me:hs", name: "Me", exp: 123 });
  const short = buildShortUrl({ site: SITE, code: "h7q2x", baseUrl: DEFAULT_HS });
  // Same origin, different page: the QR goes to the app-install offer, the
  // hand-typed short code goes to the browser worker.
  assert.equal(new URL(full).origin, new URL(short).origin);
  assert.equal(new URL(full).pathname, new URL(SITE).pathname.replace(/\/$/, "") + "/app.html");
  assert.equal(new URL(short).origin + new URL(short).pathname, SITE);
  // The invite keeps its room params for app.html's "continue in browser".
  assert.equal(new URL(full).searchParams.get("room"), "!abc:hs");
});