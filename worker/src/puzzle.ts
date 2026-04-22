import { hmacSha256, base64urlEncode, base64urlDecode, timingSafeEqual } from "./crypto-utils";

function encodeWindowId(windowId: bigint): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, windowId, false);
  return new Uint8Array(buf);
}

function currentWindowId(windowSeconds: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000 / windowSeconds));
}

export async function generateChallenge(
  secret: string,
  windowSeconds: number,
): Promise<{ nonce: string; expiresAt: string }> {
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));
  const windowId = currentWindowId(windowSeconds);

  const hmacInput = new Uint8Array(24);
  hmacInput.set(randomBytes, 0);
  hmacInput.set(encodeWindowId(windowId), 16);
  const mac = await hmacSha256(secret, hmacInput);

  const nonceBytes = new Uint8Array(48);
  nonceBytes.set(randomBytes, 0);
  nonceBytes.set(mac, 16);

  // Challenge is valid for current window plus one overlap window
  const expiresAtSec = Number(windowId + 2n) * windowSeconds;

  return {
    nonce: base64urlEncode(nonceBytes),
    expiresAt: new Date(expiresAtSec * 1000).toISOString(),
  };
}

// Verifies the nonce HMAC, accepting the current window and the immediately preceding one.
export async function verifyNonceHmac(
  nonce: string,
  secret: string,
  windowSeconds: number,
): Promise<boolean> {
  let nonceBytes: Uint8Array;
  try {
    nonceBytes = base64urlDecode(nonce);
  } catch {
    return false;
  }
  if (nonceBytes.length !== 48) return false;

  const randomBytes = nonceBytes.slice(0, 16);
  const storedMac = nonceBytes.slice(16);
  const windowId = currentWindowId(windowSeconds);

  for (const wid of [windowId, windowId - 1n]) {
    const hmacInput = new Uint8Array(24);
    hmacInput.set(randomBytes, 0);
    hmacInput.set(encodeWindowId(wid), 16);
    const mac = await hmacSha256(secret, hmacInput);
    if (timingSafeEqual(mac, storedMac)) return true;
  }
  return false;
}

export async function verifySolution(
  nonce: string,
  slotStart: string,
  solution: number,
  difficulty: number,
): Promise<boolean> {
  const preimage = `${nonce}:${slotStart}:${solution.toString()}`;
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage));
  const bytes = new Uint8Array(hashBuffer);

  const fullBytes = Math.floor(difficulty / 8);
  const remainBits = difficulty % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== 0) return false;
  }
  if (remainBits > 0) {
    const mask = (0xff << (8 - remainBits)) & 0xff;
    if ((bytes[fullBytes] & mask) !== 0) return false;
  }
  return true;
}
