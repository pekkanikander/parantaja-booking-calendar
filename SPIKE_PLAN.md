# Booking Calendar — Spike Plan (Stage 2)

> Entry condition: operator has approved ARCHITECTURE.md and this document.
> Goal: a fully working booking flow running on localhost against a real Google Calendar.
> Scope: happy path only — no error handling beyond the conflict rollback.

---

## Checklist

### 1. Repo scaffold

Create the following directory structure (no files yet; just the skeleton):

```text
booking-calendar/
├── IMPLEMENTATION-PLAN.md   (existing)
├── ARCHITECTURE.md          (existing)
├── SPIKE_PLAN.md            (this file)
├── frontend/
│   ├── index.html
│   ├── src/
│   │   ├── config.ts        ← WORKER_URL, CALENDAR_ID, SLOT_MINUTES
│   │   ├── types.ts         ← Slot, BookRequest, BookResponse
│   │   ├── api.ts           ← typed wrappers over Google Calendar REST
│   │   ├── calendar.ts      ← FullCalendar init, slot rendering
│   │   ├── booking.ts       ← booking form + optimistic flow
│   │   └── main.ts          ← entry point, mounts Calendar
│   ├── vite.config.ts
│   └── package.json
├── worker/
│   ├── src/
│   │   ├── auth.ts          ← service account JWT → access token (Web Crypto)
│   │   └── index.ts         ← transparent proxy handler
│   ├── wrangler.toml
│   └── package.json
└── .github/
    └── workflows/
        └── deploy.yml       ← stubbed; wired in Stage 3
```

---

### 2. npm packages to install

**Frontend** (`cd frontend && npm install`):

```text
@fullcalendar/core          # calendar core
@fullcalendar/timegrid      # timeGridWeek view
vite                        # dev server + build
typescript                  # compiler
```

Note: `@fullcalendar/interaction` is NOT needed — `eventClick` requires no
plugin (confirmed in FullCalendar v6 docs).

**Worker** (`cd worker && npm install`):

```text
wrangler                    # CLI: local dev + deploy
@cloudflare/workers-types   # TypeScript types for Worker globals
typescript                  # compiler
```

No JWT library needed: JWT signing is implemented via the Web Crypto API
(`crypto.subtle`), which is natively available in Cloudflare Workers.

Unknown: Will `wrangler dev` work locally without JWT library.

---

### 3. Google Cloud setup (operator steps)

Follow `docs/GOOGLE_SETUP.md` (produced as part of this stage). Summary:

1. Go to https://console.cloud.google.com and sign in with your Google account
   (personal @gmail.com account is sufficient; no Workspace required).
2. Create a new project (e.g. "booking-calendar").
3. Navigate to APIs & Services → Library → search "Google Calendar API" →
   Enable.
4. Navigate to APIs & Services → Credentials → Create Credentials →
   Service Account.
   - Name: `booking-worker` (or similar).
   - Role: none needed at GCP level (access is granted at calendar level).
   - Click Done.
5. Click the created service account → Keys → Add Key → Create new key → JSON.
   Download the JSON file. Keep it secret.
6. Open Google Calendar in a browser. Find the target calendar in the left
   sidebar → three-dot menu → Settings and sharing.
7. Under "Share with specific people", add the service account email address
   (looks like `booking-worker@<project-id>.iam.gserviceaccount.com`).
   Permission: "Make changes to events".
8. Note the Calendar ID (under "Integrate calendar" → Calendar ID).
9. Create a few test `OPEN` events (title must be exactly `OPEN`) spanning
   different durations (e.g. 09:00–11:00, 14:00–16:00) on upcoming days.

---

### 4. Cloudflare setup (operator steps)

1. Create a Cloudflare account at https://cloudflare.com if you don't have one.
   Free plan is sufficient.
2. In the `worker/` directory: `npx wrangler login` (opens browser OAuth).
3. No KV namespace needed for the spike (token cached in Worker memory).
4. Create `.dev.vars` in `worker/` (this file is gitignored):

```text
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","client_email":"booking-worker@...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n", ...}
GOOGLE_CALENDAR_ID=abc123@group.calendar.google.com
```

Paste the full JSON from step 3.5 above (minified to one line) as the value
of `GOOGLE_SERVICE_ACCOUNT_JSON`. Replace newlines in the private key with `\n`.

---

### 5. Worker implementation

**`worker/src/auth.ts`** — service account → access token (~55 LOC)

```typescript
// Module-level token cache (lasts for Worker process lifetime)
let cachedToken: string | null = null;
let tokenExpiry = 0;

export async function getAccessToken(
  serviceAccountJson: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiry - 60) return cachedToken;

  const sa = JSON.parse(serviceAccountJson) as {
    client_email: string;
    private_key: string;
  };

  // Import PKCS8 private key
  const pem = sa.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const keyBuffer = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)).buffer;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // Build JWT
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const iat = now;
  const exp = iat + 3600;
  const claims = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/calendar.events",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp,
  })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const toSign = new TextEncoder().encode(`${header}.${claims}`);
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, toSign);
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwt = `${header}.${claims}.${sig}`;

  // Exchange for access token
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiry = iat + data.expires_in;
  return cachedToken;
}
```

**`worker/src/index.ts`** — transparent proxy (~30 LOC)

```typescript
import { getAccessToken } from "./auth";

const ALLOWED_ORIGINS = ["http://localhost:5173"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin)
        ? origin : "",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
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

    const response = new Response(upstream.body, upstream);
    Object.entries(corsHeaders).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  },
} satisfies ExportedHandler<Env>;

interface Env {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  GOOGLE_CALENDAR_ID: string;
}
```

**`worker/wrangler.toml`**:

```toml
name = "booking-worker"
main = "src/index.ts"
compatibility_date = "2024-01-01"
```

---

### 6. Frontend implementation

#### TypeScript interfaces — `frontend/src/types.ts`

```typescript
export interface GCalEvent {
  id: string;
  summary: string;
  start: { dateTime: string };
  end:   { dateTime: string };
}

export interface Slot {
  id: string;     // ISO 8601 start timestamp — the slot's identity
  start: string;  // ISO 8601
  end: string;    // ISO 8601
}
```

#### `frontend/src/config.ts`

```typescript
export const WORKER_URL   = "http://localhost:8787";
export const CALENDAR_ID  = "REPLACE_WITH_YOUR_CALENDAR_ID";
export const SLOT_MINUTES = 60;
```

#### `frontend/src/api.ts` — typed wrapper over Google Calendar REST

Key functions (implement with `fetch` against `WORKER_URL`):

```typescript
listEvents(timeMin: string, timeMax: string): Promise<GCalEvent[]>
  // GET /calendar/v3/calendars/{calId}/events?timeMin=...&timeMax=...&singleEvents=true

insertEvent(summary: string, description: string,
            start: string, end: string): Promise<GCalEvent>
  // POST /calendar/v3/calendars/{calId}/events

deleteEvent(eventId: string): Promise<void>
  // DELETE /calendar/v3/calendars/{calId}/events/{eventId}
```

#### `frontend/src/calendar.ts` — slot computation + FullCalendar rendering

```typescript
// Slot computation:
function computeSlots(events: GCalEvent[]): Slot[] {
  const openEvents   = events.filter(e => e.summary === "OPEN");
  const blockedTimes = events.filter(e => e.summary !== "OPEN")
    .map(e => ({ start: new Date(e.start.dateTime),
                 end:   new Date(e.end.dateTime) }));

  const slots: Slot[] = [];
  for (const open of openEvents) {
    let cursor = new Date(open.start.dateTime);
    const openEnd = new Date(open.end.dateTime);
    while (cursor.getTime() + SLOT_MINUTES * 60_000 <= openEnd.getTime()) {
      const slotEnd = new Date(cursor.getTime() + SLOT_MINUTES * 60_000);
      const blocked = blockedTimes.some(
        b => b.start < slotEnd && b.end > cursor
      );
      if (!blocked) {
        slots.push({
          id:    cursor.toISOString(),
          start: cursor.toISOString(),
          end:   slotEnd.toISOString(),
        });
      }
      cursor = slotEnd;
    }
  }
  return slots;
}
```

FullCalendar configuration:

```typescript
import { Calendar } from "@fullcalendar/core";
import timeGridPlugin from "@fullcalendar/timegrid";

const calendar = new Calendar(el, {
  plugins: [timeGridPlugin],
  initialView: "timeGridWeek",
  slotDuration: "00:30:00",    // 30-min grid lines
  slotMinTime: "07:00:00",
  slotMaxTime: "21:00:00",
  events: [],                  // populated on datesSet
  eventColor: "#22c55e",       // green for available slots
  datesSet: async (info) => {
    const events = await listEvents(info.startStr, info.endStr);
    const slots  = computeSlots(events);
    calendar.removeAllEvents();
    slots.forEach(s => calendar.addEvent({ id: s.id, title: "Available",
      start: s.start, end: s.end }));
  },
  eventClick: (info) => {
    showBookingForm(info.event);
  },
});
calendar.render();
```

#### `frontend/src/booking.ts` — optimistic booking flow

```typescript
async function book(slot: Slot, name: string, note: string): Promise<void> {
  // 1. Insert BOOKED event
  const created = await insertEvent(name, note, slot.start, slot.end);

  // 2. Check for conflicts in the slot window
  const events = await listEvents(slot.start, slot.end);
  const conflict = events.some(
    e => e.summary !== "OPEN" && e.id !== created.id
  );

  if (conflict) {
    // 3b. Roll back and report
    await deleteEvent(created.id);
    showError("Sorry, this slot was just taken.");
    await refreshSlots();   // re-fetch so view is up to date
    return;
  }

  // 3a. Success
  calendar.getEventById(slot.id)?.remove();
  showConfirmation(name);
}
```

#### `frontend/index.html`

Minimal: one `<div id="calendar">` element; import `main.ts` as a module.

---

### 7. Local dev wiring

#### Start the Worker:

```bash
cd worker
npx wrangler dev --port 8787
# reads .dev.vars automatically
```

#### Start the Vite dev server:

```bash
cd frontend
npm run dev
# opens http://localhost:5173
```

No Vite proxy config is needed in the spike: the Worker URL is hardcoded in
`config.ts` and the Worker emits CORS headers allowing `localhost:5173`.

If a proxy is preferred instead (avoids the CORS dance), add to
`frontend/vite.config.ts`:

```typescript
export default {
  server: {
    proxy: {
      "/calendar": "http://localhost:8787",
    },
  },
};
```

And set `WORKER_URL = ""` in `config.ts`.

---

### 8. Smoke test sequence

1. `wrangler dev` is running; `vite dev` is running.
2. Open http://localhost:5173 — FullCalendar renders the current week.
3. Available slots (green) appear where the operator has created `OPEN` events.
4. Click a slot — a form appears with a name field and optional note.
5. Enter a name and click "Book" — slot disappears, confirmation shows.
6. Reload the page — the booked slot does not reappear (BOOKED event exists
   in Google Calendar; it is excluded by the slot computation).
7. Open Google Calendar — verify the BOOKED event is visible with the customer
   name as the title.
8. To test the "oops" path: manually delete the just-booked event in Google
   Calendar, re-create the slot, then have two browser windows try to book the
   same slot simultaneously.

---

**Checkpoint 2** — operator completes steps 3 (GCP setup) and 4 (Cloudflare
setup), runs the smoke test, and signs off or raises issues before Stage 3.
