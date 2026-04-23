/// <reference lib="webworker" />
declare const __WORKER_URL__: string;

const WORKER_ORIGIN = new URL(__WORKER_URL__).origin;

// Cached nonce received from the last Worker response; included in subsequent proofs.
let cachedNonce: string | undefined;

// ---- IndexedDB helpers ----

interface KeyPairRecord {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("dpop-keys", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keypairs");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<KeyPairRecord | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction("keypairs", "readonly").objectStore("keypairs").get(key);
    req.onsuccess = () => resolve(req.result as KeyPairRecord | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: KeyPairRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction("keypairs", "readwrite").objectStore("keypairs").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---- Key management ----

async function loadOrCreateKeyPair(): Promise<KeyPairRecord> {
  const db = await openDb();
  const existing = await idbGet(db, "keypair");
  if (existing) return existing;

  // Generate extractable pair so we can export the public JWK.
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );

  // Export public JWK for embedding in DPoP proofs.
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

  // Re-import private key as non-extractable.
  const privateJwkRaw = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwkRaw,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const record: KeyPairRecord = { privateKey, publicJwk };
  await idbPut(db, "keypair", record);
  return record;
}

// ---- DPoP proof construction ----

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

async function buildProof(
  privateKey: CryptoKey,
  publicJwk: JsonWebKey,
  method: string,
  htu: string,
  nonce: string | undefined,
): Promise<string> {
  // Strip key_ops and ext from the embedded JWK -- only kty/crv/x/y are needed.
  const { kty, crv, x, y } = publicJwk;
  const jwk = { kty, crv, x, y };

  const header = b64url(encodeJson({ alg: "ES256", typ: "dpop+jwt", jwk }));
  const payload = b64url(encodeJson({
    jti: crypto.randomUUID(),
    htm: method.toUpperCase(),
    htu,
    iat: Math.floor(Date.now() / 1000),
    ...(nonce !== undefined ? { nonce } : {}),
  }));

  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const sigBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    privateKey,
    signingInput,
  );

  return `${header}.${payload}.${b64url(new Uint8Array(sigBuf))}`;
}

function urlWithoutQuery(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

// ---- Service Worker lifecycle ----

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener("install", () => {
  sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  const reqUrl = new URL(req.url);

  // Only intercept requests going to the Worker origin.
  if (reqUrl.origin !== WORKER_ORIGIN) return;

  event.respondWith(
    (async () => {
      const { privateKey, publicJwk } = await loadOrCreateKeyPair();
      const htu = urlWithoutQuery(req.url);
      const proof = await buildProof(privateKey, publicJwk, req.method, htu, cachedNonce);

      const modified = new Request(req, {
        headers: new Headers({ ...Object.fromEntries(req.headers), DPoP: proof }),
      });

      const response = await fetch(modified);

      const fresh = response.headers.get("DPoP-Nonce");
      if (fresh) cachedNonce = fresh;

      return response;
    })(),
  );
});
