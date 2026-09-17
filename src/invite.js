import { createClient } from "matrix-js-sdk";
import { registerAuto, randomUsername, sha256Hex, getAccountData, setAccountData } from "./matrix.js";

export const CODE_TYPE = "org.heimdall.codes";
export const INVITE_TTL = 7 * 24 * 3600 * 1000;

export function makeSecretCode() {
  const bytes = crypto.getRandomValues(new Uint32Array(1))[0];
  return String(100000 + (bytes % 900000));
}

export function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "x");
}

export function buildInviteUrl({ site, roomId, baseUrl, host, name, exp }) {
  return `${site}?room=${encodeURIComponent(roomId)}&hs=${encodeURIComponent(baseUrl)}&host=${encodeURIComponent(host)}&name=${encodeURIComponent(name)}&exp=${exp}`;
}

/** Register a controller account if none is provided. */
export async function ensureControllerSession({ baseUrl, creds }) {
  if (creds) return creds;
  const password = randomPassword();
  const c = await registerAuto({ baseUrl, username: randomUsername("heimdall"), password });
  return { ...c, password };
}

/** Record an issued code on the account so any surface can confirm it. */
export async function issueCode({ creds, code, exp }) {
  const reg = await getAccountData({ ...creds, type: CODE_TYPE }).catch(() => null);
  const active = (reg?.active || []).filter((c) => c.exp > Date.now());
  active.push({ hash: await sha256Hex(code), exp });
  await setAccountData({ ...creds, type: CODE_TYPE, content: { active } });
  return true;
}

/** Ask the account whether a presented code hash is one it issued. */
export async function confirmCode({ creds, codeHash }) {
  const reg = await getAccountData({ ...creds, type: CODE_TYPE }).catch(() => null);
  const active = (reg?.active || []).filter((c) => c.exp > Date.now());
  return active.some((c) => c.hash === codeHash);
}

/**
 * The one function every surface uses to mint an invite:
 *  - ensures a controller account (or reuses the provided one),
 *  - creates (or reuses) a fleet room,
 *  - generates a 6-digit code, records it on the account,
 *  - returns the share link and the code.
 * Works in the browser and in Node (CLI / fold).
 */
export async function createInvite({ baseUrl, creds, roomId, displayName, site }) {
  creds = await ensureControllerSession({ baseUrl, creds });
  const client = createClient({
    baseUrl,
    accessToken: creds.accessToken,
    userId: creds.userId,
    deviceId: creds.deviceId,
  });
  if (!roomId) {
    const room = await client.createRoom({
      name: `heimdall-${Math.random().toString(36).slice(2, 7)}`,
      preset: "public_chat",
      visibility: "private",
    });
    roomId = room.room_id;
  }
  const code = makeSecretCode();
  const exp = Date.now() + INVITE_TTL;
  const name = displayName || creds.userId;
  await issueCode({ creds, code, exp });
  return {
    url: buildInviteUrl({ site, roomId, baseUrl, host: creds.userId, name, exp }),
    code,
    exp,
    roomId,
    creds,
  };
}