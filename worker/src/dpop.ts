import { jwtVerify, EmbeddedJWK } from "jose";
import { generateChallenge } from "./puzzle";

export type DpopValidation =
  | { ok: true; nonce: string | undefined }
  | { ok: false; missing: boolean };

export async function validateDpopProof(
  proofHeader: string | null,
  method: string,
  requestUrl: string,
): Promise<DpopValidation> {
  if (proofHeader === null) return { ok: false, missing: true };

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(proofHeader, EmbeddedJWK, {
      typ: "dpop+jwt",
      algorithms: ["ES256"],
      maxTokenAge: "60s",
    });
    payload = result.payload as Record<string, unknown>;
  } catch {
    return { ok: false, missing: false };
  }

  if (payload.htm !== method.toUpperCase()) return { ok: false, missing: false };
  if (payload.htu !== urlWithoutQuery(requestUrl)) return { ok: false, missing: false };
  if (typeof payload.jti !== "string" || payload.jti.length === 0) return { ok: false, missing: false };

  return {
    ok: true,
    nonce: typeof payload.nonce === "string" ? payload.nonce : undefined,
  };
}

export async function generateDpopNonce(
  secret: string,
  windowSeconds: number,
): Promise<string> {
  const { nonce } = await generateChallenge(secret, windowSeconds);
  return nonce;
}

function urlWithoutQuery(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}
