// Service account (JWT bearer) token cache
let saToken: string | null = null;
let saExpiry = 0;

// Refresh token cache
let rtToken: string | null = null;
let rtExpiry = 0;

function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64urlStr(s: string): string {
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function getAccessTokenFromServiceAccount(serviceAccountJson: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (saToken && now < saExpiry - 60) return saToken;

  const sa = JSON.parse(serviceAccountJson) as { client_email: string; private_key: string };
  const pem = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyBuffer = Uint8Array.from(atob(pem), c => c.charCodeAt(0)).buffer;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const header = base64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = now;
  const exp = iat + 3600;
  const claims = base64urlStr(JSON.stringify({
    iss:   sa.client_email,
    // google-caldav: calendar.events scope is insufficient for CalDAV; must use full calendar scope
    scope: "https://www.googleapis.com/auth/calendar",
    aud:   "https://oauth2.googleapis.com/token",
    iat,
    exp,
  }));

  const sigBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const jwt = `${header}.${claims}.${base64url(sigBuffer)}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!resp.ok) throw new Error(`Service account token exchange failed: ${resp.status}`);
  const data = await resp.json() as { access_token: string; expires_in: number };
  saToken = data.access_token;
  saExpiry = iat + data.expires_in;
  return saToken;
}

export async function getAccessTokenFromRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (rtToken && now < rtExpiry - 60) return rtToken;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }).toString(),
  });
  if (!resp.ok) throw new Error(`Refresh token exchange failed: ${resp.status}`);
  const data = await resp.json() as { access_token: string; expires_in: number };
  rtToken = data.access_token;
  rtExpiry = now + data.expires_in;
  return rtToken;
}
