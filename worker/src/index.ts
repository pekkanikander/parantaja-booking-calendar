import { getAccessTokenFromServiceAccount, getAccessTokenFromRefreshToken } from "./auth";
import { reportEvents, buildVEvent, putEvent, deleteEvent } from "./caldav";
import { computeSlots } from "./slots";

interface Env {
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  CALDAV_CALENDAR_URL: string;
  SLOT_MINUTES: string;
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

const ALLOWED_ORIGINS = ["http://localhost:5173"];

function corsHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // GET /v1/slots
    if (request.method === "GET" && path === "/v1/slots") {
      const start = url.searchParams.get("start");
      const end   = url.searchParams.get("end");
      if (!start || !end) {
        return json(
          { status: "error", error: { code: "bad_request", message: "missing start/end" } },
          400, cors,
        );
      }
      let token: string;
      try {
        token = await getAccessToken(env);
      } catch {
        return json(
          { status: "error", error: { code: "caldav_error", message: "auth failed" } },
          502, cors,
        );
      }
      let events;
      try {
        events = await reportEvents(env.CALDAV_CALENDAR_URL, token, start, end);
      } catch {
        return json(
          { status: "error", error: { code: "caldav_error", message: "caldav error" } },
          502, cors,
        );
      }
      const slotMinutes = parseInt(env.SLOT_MINUTES, 10);
      const available = computeSlots(events, slotMinutes).filter(s => s.available);
      const grouped: Record<string, { start: string; end: string }[]> = {};
      for (const s of available) {
        const day = s.start.slice(0, 10);
        (grouped[day] ??= []).push({ start: s.start, end: s.end });
      }
      return json({ status: "success", data: { slots: grouped } }, 200, cors);
    }

    // POST /v1/bookings
    if (request.method === "POST" && path === "/v1/bookings") {
      let body: { start?: string; attendee?: { name?: string; email?: string }; notes?: string };
      try {
        body = await request.json() as typeof body;
      } catch {
        return json(
          { status: "error", error: { code: "bad_request", message: "invalid body" } },
          400, cors,
        );
      }
      if (!body.start || !body.attendee?.name) {
        return json(
          { status: "error", error: { code: "bad_request", message: "missing start or attendee.name" } },
          400, cors,
        );
      }

      const slotMinutes = parseInt(env.SLOT_MINUTES, 10);
      const startDate = new Date(body.start);
      const endDate   = new Date(startDate.getTime() + slotMinutes * 60_000);
      const start = startDate.toISOString();
      const end   = endDate.toISOString();

      const uid = crypto.randomUUID();
      const ics = buildVEvent(uid, start, end, body.attendee.name, body.notes ?? "");

      let token: string;
      try {
        token = await getAccessToken(env);
      } catch {
        return json(
          { status: "error", error: { code: "caldav_error", message: "auth failed" } },
          502, cors,
        );
      }

      await putEvent(env.CALDAV_CALENDAR_URL, token, uid, ics);

      const events = await reportEvents(env.CALDAV_CALENDAR_URL, token, start, end);
      const conflict = events.some(e => e.summary !== "OPEN" && e.uid !== uid);
      if (conflict) {
        await deleteEvent(env.CALDAV_CALENDAR_URL, token, uid);
        return json(
          { status: "error", error: { code: "conflict", message: "slot taken" } },
          409, cors,
        );
      }

      return json({ status: "success", data: { uid, start, end } }, 200, cors);
    }

    // DELETE /v1/bookings/:uid
    const deleteMatch = path.match(/^\/v1\/bookings\/([^/]+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      const uid = deleteMatch[1];
      let token: string;
      try {
        token = await getAccessToken(env);
      } catch {
        return json(
          { status: "error", error: { code: "caldav_error", message: "auth failed" } },
          502, cors,
        );
      }
      const found = await deleteEvent(env.CALDAV_CALENDAR_URL, token, uid);
      if (!found) {
        return json(
          { status: "error", error: { code: "not_found", message: "not found" } },
          404, cors,
        );
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (path.startsWith("/v1/")) {
      return json(
        { status: "error", error: { code: "method_not_allowed", message: "method not allowed" } },
        405, cors,
      );
    }
    return json(
      { status: "error", error: { code: "not_found", message: "not found" } },
      404, cors,
    );
  },
} satisfies ExportedHandler<Env>;
