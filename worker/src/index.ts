import { getAccessToken } from "./auth";

interface Env {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  GOOGLE_CALENDAR_ID: string;
}

const ALLOWED_ORIGINS = ["http://localhost:5173"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (ALLOWED_ORIGINS.includes(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "PATCH" || request.method === "PUT") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    const token = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const url = new URL(request.url);
    const target = "https://www.googleapis.com" + url.pathname + url.search;

    const upstream = await fetch(target, {
      method: request.method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": request.headers.get("Content-Type") ?? "application/json",
      },
      body: request.method !== "GET" && request.method !== "DELETE"
        ? request.body : undefined,
    });

    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
    for (const [k, v] of Object.entries(corsHeaders)) {
      response.headers.set(k, v);
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
