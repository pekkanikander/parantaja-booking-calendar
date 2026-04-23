import { getAccessTokenFromServiceAccount, getAccessTokenFromRefreshToken } from "./auth";
import { reportEvents, buildVEvent, putEvent, deleteEvent, getEvent, extractBookingHash } from "./caldav";
import { hmacSha256, base64urlEncode, base64urlDecode, timingSafeEqual } from "./crypto-utils";
import { generateChallenge, verifyNonceHmac, verifySolution } from "./puzzle";
import { validateDpopProof, generateDpopNonce } from "./dpop";
import { computeSlots } from "./slots";
import { problem } from "./problem";

interface Env {
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  CALDAV_CALENDAR_URL: string;
  SLOT_MINUTES: string;
  WORKER_NONCE_SECRET: string;
  WORKER_PUZZLE_SECRET: string;
  PUZZLE_DIFFICULTY: string;
  PUZZLE_WINDOW_SECONDS: string;
  WORKER_DPOP_SECRET: string;
  DPOP_WINDOW_SECONDS: string;
  BOOKING_RL?: RateLimit;  // absent in wrangler dev; rate limiting is skipped locally
}

function getAccessToken(env: Env): Promise<string> {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return getAccessTokenFromServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    return getAccessTokenFromRefreshToken(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REFRESH_TOKEN);
  }
  return Promise.reject(new Error("No auth credentials configured"));
}

const ALLOWED_ORIGINS = ["http://localhost:5173", "https://bookings.pnr.iki.fi"];

function corsHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, DPoP",
    "Access-Control-Expose-Headers": "DPoP-Nonce",
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function checkEnv(env: Env): string | null {
  if (!env.CALDAV_CALENDAR_URL)   return "CALDAV_CALENDAR_URL is not set";
  if (!env.WORKER_NONCE_SECRET)   return "WORKER_NONCE_SECRET is not set";
  if (!env.WORKER_PUZZLE_SECRET)  return "WORKER_PUZZLE_SECRET is not set";
  if (!env.WORKER_DPOP_SECRET)    return "WORKER_DPOP_SECRET is not set";
  const hasServiceAccount = !!env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const hasOAuth = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
  if (!hasServiceAccount && !hasOAuth) return "No Google auth credentials configured";
  return null;
}

const SLOT_START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    const cors = corsHeaders(origin);

    const envError = checkEnv(env);
    if (envError) {
      console.error("Worker misconfigured:", envError);
      return problem(500, "Internal Server Error", "Worker is misconfigured; check secrets.", cors);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // DPoP validation — runs before every /v1/* route
    const dpopWindow = parseInt(env.DPOP_WINDOW_SECONDS, 10);
    const dpopNonce = await generateDpopNonce(env.WORKER_DPOP_SECRET, dpopWindow);
    const dpopCors = { ...cors, "DPoP-Nonce": dpopNonce };

    if (path.startsWith("/v1/")) {
      const proof = await validateDpopProof(
        request.headers.get("DPoP"),
        request.method,
        request.url,
      );

      const isWrite = request.method === "POST" || request.method === "DELETE";

      if (!proof.ok) {
        // GET requests tolerate a missing proof on first page load (SW not yet active).
        // Writes always require a proof.
        if (isWrite || !proof.missing) {
          return new Response(null, {
            status: 401,
            headers: { "WWW-Authenticate": "DPoP", ...dpopCors },
          });
        }
      } else if (proof.nonce !== undefined) {
        // Proof present and carries a nonce — verify it.
        const nonceOk = await verifyNonceHmac(proof.nonce, env.WORKER_DPOP_SECRET, dpopWindow);
        if (!nonceOk) {
          return new Response(null, {
            status: 401,
            headers: { "WWW-Authenticate": "DPoP error=\"use_dpop_nonce\"", ...dpopCors },
          });
        }
      } else if (isWrite) {
        // Write with a valid proof but no nonce — require one.
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": "DPoP error=\"use_dpop_nonce\"", ...dpopCors },
        });
      }
    }

    // GET /v1/challenge
    if (request.method === "GET" && path === "/v1/challenge") {
      const windowSeconds = parseInt(env.PUZZLE_WINDOW_SECONDS, 10);
      const difficulty    = parseInt(env.PUZZLE_DIFFICULTY, 10);
      const { nonce, expiresAt } = await generateChallenge(env.WORKER_PUZZLE_SECRET, windowSeconds);
      return json({ nonce, difficulty, expires_at: expiresAt }, 200, dpopCors);
    }

    // GET /v1/slots
    if (request.method === "GET" && path === "/v1/slots") {
      const start = url.searchParams.get("start");
      const end   = url.searchParams.get("end");
      if (!start || !end) {
        return problem(400, "Bad Request", "Missing start or end query parameter.", dpopCors);
      }
      let token: string;
      try {
        token = await getAccessToken(env);
      } catch (e) {
        console.error("auth failed", e);
        return problem(502, "Bad Gateway", "Authentication failed.", dpopCors);
      }
      let events;
      try {
        events = await reportEvents(env.CALDAV_CALENDAR_URL, token, start, end);
      } catch (e) {
        console.error("caldav error", e);
        return problem(502, "Bad Gateway", "CalDAV request failed.", dpopCors);
      }
      const slotMinutes = parseInt(env.SLOT_MINUTES, 10);
      const available = computeSlots(events, slotMinutes).filter(s => s.available);
      const grouped: Record<string, { start: string; end: string }[]> = {};
      for (const s of available) {
        const day = s.start.slice(0, 10);
        (grouped[day] ??= []).push({ start: s.start, end: s.end });
      }
      return json({ status: "success", data: { slots: grouped } }, 200, dpopCors);
    }

    // POST /v1/bookings
    if (request.method === "POST" && path === "/v1/bookings") {
      if (env.BOOKING_RL) {
        const { success } = await env.BOOKING_RL.limit({
          key: request.headers.get("CF-Connecting-IP") ?? "unknown",
        });
        if (!success) {
          return problem(429, "Too Many Requests", "Rate limit exceeded; try again later.", dpopCors);
        }
      }

      let body: {
        slot_start?: unknown;
        attendee?: { name?: unknown; email?: unknown };
        notes?: unknown;
        puzzle_nonce?: unknown;
        puzzle_solution?: unknown;
      };
      try {
        body = await request.json() as typeof body;
      } catch {
        return problem(400, "Bad Request", "Request body is not valid JSON.", dpopCors);
      }

      // --- Input validation ---
      if (typeof body.slot_start !== "string" || !SLOT_START_RE.test(body.slot_start) || isNaN(Date.parse(body.slot_start))) {
        return problem(400, "Bad Request", "slot_start must be a UTC ISO 8601 datetime string.", dpopCors);
      }
      if (typeof body.attendee?.name !== "string" || body.attendee.name.trim() === "") {
        return problem(400, "Bad Request", "attendee.name must be a non-empty string.", dpopCors);
      }
      if (body.attendee.name.length > 200) {
        return problem(400, "Bad Request", "attendee.name must not exceed 200 characters.", dpopCors);
      }
      if (body.attendee.email !== undefined && typeof body.attendee.email !== "string") {
        return problem(400, "Bad Request", "attendee.email must be a string.", dpopCors);
      }
      if (body.notes !== undefined) {
        if (typeof body.notes !== "string") {
          return problem(400, "Bad Request", "notes must be a string.", dpopCors);
        }
        if (body.notes.length > 1000) {
          return problem(400, "Bad Request", "notes must not exceed 1000 characters.", dpopCors);
        }
      }
      if (typeof body.puzzle_nonce !== "string" || !/^[A-Za-z0-9_-]{64}$/.test(body.puzzle_nonce)) {
        return problem(400, "Bad Request", "puzzle_nonce must be a 64-character base64url string.", dpopCors);
      }
      if (
        typeof body.puzzle_solution !== "number" ||
        !Number.isInteger(body.puzzle_solution) ||
        body.puzzle_solution < 0 ||
        body.puzzle_solution > 0xffffffff
      ) {
        return problem(400, "Bad Request", "puzzle_solution must be a uint32.", dpopCors);
      }

      // Puzzle verification (cheapest check first: SHA-256 solution, then HMAC nonce)
      const puzzleDifficulty = parseInt(env.PUZZLE_DIFFICULTY, 10);
      const puzzleWindow     = parseInt(env.PUZZLE_WINDOW_SECONDS, 10);

      const solutionOk = await verifySolution(
        body.puzzle_nonce, body.slot_start, body.puzzle_solution, puzzleDifficulty,
      );
      if (!solutionOk) {
        return problem(400, "Bad Request", "Puzzle solution is incorrect.", dpopCors);
      }

      const nonceOk = await verifyNonceHmac(body.puzzle_nonce, env.WORKER_PUZZLE_SECRET, puzzleWindow);
      if (!nonceOk) {
        return problem(400, "Bad Request", "Puzzle nonce is expired or invalid.", dpopCors);
      }

      const slotStart    = body.slot_start;
      const attendeeName = body.attendee.name.trim();
      const notes        = typeof body.notes === "string" ? body.notes : "";

      const slotMinutes = parseInt(env.SLOT_MINUTES, 10);
      const startDate = new Date(slotStart);
      const endDate   = new Date(startDate.getTime() + slotMinutes * 60_000);
      const start = startDate.toISOString();
      const end   = endDate.toISOString();

      const uid = crypto.randomUUID();
      const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
      const cancellationNonce = base64urlEncode(nonceBytes);
      const hashBytes = await hmacSha256(env.WORKER_NONCE_SECRET, nonceBytes);
      const bookingHash = base64urlEncode(hashBytes);
      const ics = buildVEvent(uid, start, end, attendeeName, notes, bookingHash);

      let token: string;
      try {
        token = await getAccessToken(env);
      } catch (e) {
        console.error("auth failed", e);
        return problem(502, "Bad Gateway", "Authentication failed.", dpopCors);
      }

      await putEvent(env.CALDAV_CALENDAR_URL, token, uid, ics);

      const events = await reportEvents(env.CALDAV_CALENDAR_URL, token, start, end);
      const conflict = events.some(e => e.summary !== "OPEN" && e.uid !== uid);
      if (conflict) {
        await deleteEvent(env.CALDAV_CALENDAR_URL, token, uid);
        return problem(409, "Conflict", "The requested slot is no longer available.", dpopCors);
      }

      return json({ status: "success", data: { uid, start, end, cancellation_nonce: cancellationNonce } }, 200, dpopCors);
    }

    // DELETE /v1/bookings/:uid
    const deleteMatch = path.match(/^\/v1\/bookings\/([^/]+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      const uid = deleteMatch[1];

      let deleteBody: { nonce?: unknown };
      try {
        deleteBody = await request.json() as typeof deleteBody;
      } catch {
        return problem(400, "Bad Request", "Request body is not valid JSON.", dpopCors);
      }
      if (typeof deleteBody.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(deleteBody.nonce)) {
        return problem(400, "Bad Request", "nonce must be a 43-character base64url string.", dpopCors);
      }

      let token: string;
      try {
        token = await getAccessToken(env);
      } catch (e) {
        console.error("auth failed", e);
        return problem(502, "Bad Gateway", "Authentication failed.", dpopCors);
      }

      const icsText = await getEvent(env.CALDAV_CALENDAR_URL, token, uid);
      if (icsText === null) {
        return problem(404, "Not Found", "Booking not found.", dpopCors);
      }

      const storedHash = extractBookingHash(icsText);
      if (storedHash === null) {
        return problem(403, "Forbidden", "Booking hash not found.", dpopCors);
      }

      const providedNonceBytes = base64urlDecode(deleteBody.nonce);
      const recomputedBytes = await hmacSha256(env.WORKER_NONCE_SECRET, providedNonceBytes);
      const storedHashBytes = base64urlDecode(storedHash);
      if (!timingSafeEqual(recomputedBytes, storedHashBytes)) {
        return problem(403, "Forbidden", "Invalid cancellation nonce.", dpopCors);
      }

      await deleteEvent(env.CALDAV_CALENDAR_URL, token, uid);
      return new Response(null, { status: 204, headers: dpopCors });
    }

    if (path.startsWith("/v1/")) {
      return problem(405, "Method Not Allowed", "Method not allowed.", dpopCors);
    }
    return problem(404, "Not Found", "Not found.", dpopCors);
  },
} satisfies ExportedHandler<Env>;
