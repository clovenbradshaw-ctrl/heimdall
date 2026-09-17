import { generateDeviceKeyPair, importPublicKeyB64, importPrivateKeyJwk, codeFromPublicKey, signText, verifyText, pairingPayload } from "./src/invite.js";
import { sha256Hex } from "./src/matrix.js";

const { pubB64, privJwk } = await generateDeviceKeyPair();
const code = await codeFromPublicKey(pubB64);
const codeHash = await sha256Hex(code);
console.log("code (fingerprint):", code, "| 6-digit:", /^\d{6}$/.test(code));

// worker side
const priv = await importPrivateKeyJwk(privJwk);
const payload = pairingPayload("!room:hs", "@worker:hs", "DEV", codeHash);
const sig = await signText(priv, payload);

// host side
const pub = await importPublicKeyB64(pubB64);
const fp = await codeFromPublicKey(pubB64);
const fpMatches = (await sha256Hex(fp)) === codeHash;
const sigOk = await verifyText(pub, payload, sig);
const tampered = await verifyText(pub, payload.slice(0, -2) + "xx", sig);

console.log("fingerprint matches code:", fpMatches);
console.log("signature valid:", sigOk);
console.log("signature rejected on tampered payload:", !tampered);

// forged: wrong key tries to present the same code
const { pubB64: pubB, privJwk: privB } = await generateDeviceKeyPair();
const codeB = await codeFromPublicKey(pubB64);
const privBk = await importPrivateKeyJwk(privB);
const sigB = await signText(privBk, pairingPayload("!room:hs", "@worker:hs", "DEV", codeHash));
const pubBk = await importPublicKeyB64(pubB64);
console.log("forged key rejected (fingerprint mismatch):", !((await sha256Hex(codeB)) === codeHash));
console.log("forged signature under victim pubkey rejected:", !(await verifyText(pubBk, payload, sigB)));
