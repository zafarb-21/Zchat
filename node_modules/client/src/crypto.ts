const KEYPAIR_STORAGE = "zchat_ecdh_keypair_jwk_v1";

function strToBuf(s: string) {
  return new TextEncoder().encode(s);
}
function bufToB64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToBuf(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function loadOrCreateIdentityKeypair() {
  const stored = localStorage.getItem(KEYPAIR_STORAGE);
  if (stored) {
    const jwk = JSON.parse(stored);
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      jwk.privateKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk.publicKey,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );
    return { publicKey, privateKey, publicKeyJwk: jwk.publicKey };
  }

  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);

  localStorage.setItem(KEYPAIR_STORAGE, JSON.stringify({ publicKey: publicKeyJwk, privateKey: privateKeyJwk }));
  return { publicKey: kp.publicKey, privateKey: kp.privateKey, publicKeyJwk };
}

async function hkdf(secret: ArrayBuffer, salt: ArrayBuffer, info: ArrayBuffer) {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function deriveSessionKey(myPrivateKey: CryptoKey, peerPublicKeyJwk: any, context: string) {
  const peerPublicKey = await crypto.subtle.importKey(
    "jwk",
    peerPublicKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );

  const secretBits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, myPrivateKey, 256);
  return hkdf(secretBits, strToBuf("zchat-salt-v1").buffer, strToBuf(`zchat-info-v1:${context}`).buffer);
}

export async function encryptToPayload(aesKey: CryptoKey, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, strToBuf(plaintext));
  return JSON.stringify({ iv: bufToB64(iv.buffer), ct: bufToB64(ct) });
}

export async function decryptFromPayload(aesKey: CryptoKey, payload: string) {
  const { iv, ct } = JSON.parse(payload);
  const ivBuf = new Uint8Array(b64ToBuf(iv));
  const ctBuf = b64ToBuf(ct);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, aesKey, ctBuf);
  return new TextDecoder().decode(pt);
}
