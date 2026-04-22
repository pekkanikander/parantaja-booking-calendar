# Booking Calendar — Architecture (CalDAV)

> Produced at end of Stage 1. Supersedes the archived Google REST API version
> at `archive/spike-google-calendar/ARCHITECTURE.md`.
> Revised at end of Stage 4. Revise when stage findings change any decision.

A brief note on longer-term direction is provided in §10. The current architecture is intentionally minimal and pragmatic, but it is also positioned as a small step toward a more direct, capability-oriented web architecture where browser clients could interact with services without intermediary shims.

---

## 1. Component Diagram

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Operator's device                                                  │
│  Calendar.app / iOS Calendar / any CalDAV client                    │
│    └── creates OPEN events in the target CalDAV calendar            │
└───────────────────────────────────────────┬─────────────────────────┘
                                            │ CalDAV (HTTPS)
                                            ▼
                                   ┌─────────────────────────┐
                                   │  CalDAV calendar server │
                                   │                         │
                                   │  Spike:  Google CalDAV  │
                                   │  Target: Nextcloud,     │
                                   │          Baïkal,        │
                                   │          Radicale       │
                                   └─────────────────────────┘
                                            ▲
                                            │ CalDAV (HTTPS)
                                            ▼
┌─────────────────────────────┐    ┌────────────────────────┐
│  GitHub Pages               │    │  Cloudflare Worker     │
│  (static SPA)               │    │  (domain API)          │
│                             │    │                        │
│  FullCalendar timeGridWeek  │    │  GET  /v1/slots        │
│  Booking form               │◄──►│  POST /v1/bookings     │
│  api.ts (JSON only)         │    │  DELETE /v1/bookings/:uid │
│                             │    │                        │
│                             │    │  Internally:           │
│                             │    │  • auth (JWT→token)    │
│                             │    │  • CalDAV REPORT/PUT/  │
│                             │    │    DELETE              │
│                             │    │  • ical.js parsing     │
│                             │    │  • slot computation    │
└─────────────────────────────┘    └────────────────────────┘
```

The Worker is no longer a transparent proxy, as it was in the archived first spike.
It owns the booking domain: slot computation, conflict detection, and CalDAV write operations all live in the Worker.
The SPA speaks JSON and has no knowledge of CalDAV.

---

## 2. Data Flow

### Operator paints availability

1. Operator creates an event titled exactly `OPEN` in the designated calendar
   using any CalDAV-compatible client (Calendar.app, iOS Calendar, Thunderbird,
   Nextcloud web UI, etc.).
2. The `OPEN` event spans the available window (e.g. 09:00–17:00). It may be
   longer than a single bookable slot.
3. The event is saved directly to the CalDAV server. The Worker and SPA are
   not involved.

### Customer views available slots

1. Browser loads the SPA from GitHub Pages.
2. SPA calls `GET /v1/slots?start={ISO8601}&end={ISO8601}` on the Worker.
3. Worker:
   a. Obtains (or returns cached) access token.
   b. Issues a CalDAV `REPORT` with a `calendar-query` and `time-range`
      filter to the CalDAV server.
   c. Parses the `207 Multi-Status` XML response; extracts `calendar-data`
      properties (iCal strings).
   d. Parses each iCal string with `ical.js`; extracts `VEVENT` components.
   e. Separates events: `SUMMARY=OPEN` → open windows; all others → blocked.
   f. Runs slot computation (see §5).
   g. Returns a Cal.com-shaped but much poorer JSON object, e.g.
   {
     status: "success",
     data: {
       slots: {
         "2026-04-20": [
           { start: "...", end: "...", available: true }
         ]
       }
     }
   }
4. SPA renders available slots as clickable green events in FullCalendar. Booked slots are simply omitted from the response rather than returned as red items.

### Customer books a slot

1. Customer clicks a slot; a minimal inline form appears (name, optional note,
   confirm button).
2. Before submitting, the SPA fetches a proof-of-work challenge from
   `GET /v1/challenge` and solves it in a dedicated Web Worker thread (see §3a).
3. SPA calls `POST /v1/bookings` with body
   `{slot_start, attendee: {name, email?}, notes?, puzzle_nonce, puzzle_solution}`.
4. Worker:
   a. Checks IP rate limit (Cloudflare built-in binding).
   b. Validates all input fields; returns `400 Problem Details` on any failure.
   c. Verifies the puzzle solution (SHA-256 leading zeros), then the nonce HMAC.
   d. Generates a UUID as the event UID.
   e. Generates a 32-byte random cancellation nonce; computes
      `HMAC-SHA256(WORKER_NONCE_SECRET, nonce)` and stores it as
      `X-BOOKING-HASH` in the VEVENT.
   f. Builds the `VEVENT` iCal string and issues a CalDAV `PUT`.
   g. Issues a CalDAV `REPORT` for the same time window to check for
      conflicts (any non-OPEN event other than the just-created one).
   h. If conflict: issues `DELETE` for the just-created event; returns `409`.
   i. If no conflict: returns `200` with
      `{status: "success", data: {uid, start, end, cancellation_nonce}}`.
5. SPA receives response:
   - Success: removes slot from calendar view, shows confirmation, stores
     `cancellation_nonce` in `localStorage` keyed by `uid`.
   - Conflict (409): shows "slot just taken" message; re-fetches slots.

### OPEN event lifecycle

OPEN events are never modified or deleted by the Worker or SPA. After all
slots within an OPEN window are booked, the OPEN event remains in the calendar
but the Worker's slot computation produces no available sub-slots from it.

---

## 3. Credential Approach

### Spike: Google CalDAV — dual-mode auth

Google Calendar exposes CalDAV at:
`https://apidata.googleusercontent.com/caldav/v2/{calId}/events/`

**Prerequisite:** the CalDAV API (`caldav.googleapis.com`) must be explicitly
enabled in GCP Console. It is separate from the Google Calendar API and is not
enabled by default; every CalDAV call returns `403` until it is.

Two auth methods are supported, selected by which env vars are present.
See `docs/GOOGLE_CALDAV_SETUP.md` for step-by-step setup instructions.

**Method 1 — service account (preferred):** `auth.ts` builds a self-signed JWT
(`RS256`) and exchanges it for a Bearer token via `POST oauth2.googleapis.com/token`
using `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`. The target
calendar must be shared with the service account email. Requires
`GOOGLE_SERVICE_ACCOUNT_JSON` in env.

**Method 2 — user OAuth refresh token (fallback):** used when the CalDAV
endpoint rejects service account tokens (observed on some personal Google
accounts). A one-time interactive consent flow (via OAuth Playground) yields a
refresh token, which `auth.ts` exchanges for a Bearer token via
`grant_type=refresh_token`. Requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
and `GOOGLE_REFRESH_TOKEN` in env.

Required scope (both methods): `https://www.googleapis.com/auth/calendar`
(Google CalDAV does not accept the narrower `calendar.events` scope reliably.)

### Production target: app password or OAuth2

For non-Google CalDAV servers:

- **Nextcloud**: operator creates an app password in Nextcloud settings;
  Worker uses HTTP Basic auth (`Authorization: Basic base64(user:apppassword)`).
- **Baïkal / Radicale**: HTTP Basic auth with the configured credentials.
- **OAuth2** (future): Nextcloud supports OAuth2; deferred to Stage 6.

Basic auth support in `auth.ts` is deferred to Stage 6, when non-Google CalDAV
servers are tested.

### 3a. Security analysis

#### Attack surface — domain API vs transparent proxy

The domain API is a materially narrower attack surface than the transparent
proxy in the archived spike. An unauthenticated caller can only:

| Operation | Via domain API | Impact |
| --- | --- | --- |
| List available slots | `GET /slots` (by design) | No PII — only free/busy times |
| Read booked event details | Not exposed | Eliminated vs. archived spike |
| Insert an event | `POST /book` (by design) | Fake bookings in OPEN windows; see below |
| Delete any booking | `DELETE /bookings/:uid` (requires uid) | See nonce mitigation below |
| Modify OPEN events | Not exposed | Eliminated vs. archived spike |
| Delete OPEN events | Not exposed | Eliminated vs. archived spike |
| Access other calendars | No | Credentials scoped to one calendar |

Reading booked event details (customer names, notes) is no longer possible
through the Worker API, which eliminates the PII exposure present in the
transparent proxy.

#### Fake booking creation — mitigations implemented in Stage 4

Two independent layers now defend against slot-squatting:

**Rate limiting**: Cloudflare's built-in rate-limit binding caps `POST /v1/bookings`
at 5 requests per 60-second window per IP. Parameters are in `wrangler.toml`
`[[rate_limiting]]` and take effect on redeploy.

**Proof-of-work puzzle**: Before submitting a booking, the browser must fetch a
challenge from `GET /v1/challenge` and find a uint32 `solution` such that
`SHA-256(nonce + ":" + slot_start + ":" + solution)` has ≥ 10 leading zero bits.
The `slot_start` binding prevents reuse of a solved puzzle across different slots.

Challenge nonce structure (stateless, no KV):
```
random_bytes  = 16 random bytes
window_id     = floor(unix_seconds / PUZZLE_WINDOW_SECONDS)
nonce         = base64url(random_bytes || HMAC-SHA256(WORKER_PUZZLE_SECRET, random_bytes || encode_u64_be(window_id)))
```
48 bytes total → 64 base64url characters. The Worker accepts the current and
immediately preceding window (~60 s validity). Parameters `PUZZLE_DIFFICULTY`
and `PUZZLE_WINDOW_SECONDS` are in `wrangler.toml [vars]`.

Solving runs in a browser dedicated Web Worker thread (`puzzle.worker.ts`) so
the main thread remains responsive. At difficulty 10 (~1024 iterations), solving
takes < 50 ms; this is not a UX burden but is a meaningful barrier to scripted
bulk attacks. Replay within a window is tolerated; rate limiting provides the
residual bound.

The puzzle is verified on the Worker in cheapest-first order: input validation
(sync) → SHA-256 solution check → HMAC-SHA256 nonce check.

#### Booking deletion — nonce protection implemented in Stage 4

The Worker must be able to delete a booking it just created (conflict rollback).
Exposing `DELETE /bookings/:uid` with no gate means anyone who discovers a UID
can delete a legitimate booking.

Implemented mitigation:

1. On `POST /v1/bookings`, the Worker generates a 32-byte cryptographically random
   nonce and stores `HMAC-SHA256(WORKER_NONCE_SECRET, nonce)` (base64url) in the
   `VEVENT` as `X-BOOKING-HASH` before issuing the CalDAV `PUT`.
2. The raw nonce is returned to the SPA as `cancellation_nonce` in the response
   and stored in `localStorage` keyed by `uid`.
3. `DELETE /v1/bookings/:uid` requires a JSON body `{ "nonce": "..." }`. The Worker
   fetches the event via `GET`, recomputes the HMAC using `WORKER_NONCE_SECRET`,
   and compares with timing-safe equality. Mismatch → 403.

HMAC is used rather than plain SHA-256 so that a party with CalDAV read access
cannot build a preimage table without knowing `WORKER_NONCE_SECRET`.

Cost: one extra CalDAV `GET` per customer-initiated cancellation. A booking can
only be cancelled via the Worker from the browser session that created it.
Operator-side deletion through any CalDAV client is always available and
unaffected.

---

## 4. CalDAV Wire Format

### List events — `REPORT` with `calendar-query`

```http
REPORT {calendarUrl} HTTP/1.1
Depth: 1
Content-Type: application/xml; charset=utf-8
Authorization: Bearer {token}

<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:"
                  xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="{YYYYMMDDTHHmmssZ}"
                      end="{YYYYMMDDTHHmmssZ}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>
```

Response: `207 Multi-Status`. Each `<d:response>` contains a
`<c:calendar-data>` property with a `VCALENDAR` string. Parsed with `ical.js`.

### Create event — `PUT`

```http
PUT {calendarUrl}/{uid}.ics HTTP/1.1
Content-Type: text/calendar; charset=utf-8
Authorization: Bearer {token}

BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//booking-calendar//EN
BEGIN:VEVENT
UID:{uid}
DTSTART:{YYYYMMDDTHHmmssZ}
DTEND:{YYYYMMDDTHHmmssZ}
SUMMARY:{customer name}
DESCRIPTION:{note}
X-BOOKING-HASH:{base64url of HMAC-SHA256(WORKER_NONCE_SECRET, cancellation_nonce_bytes)}
END:VEVENT
END:VCALENDAR
```

Response: `201 Created` (new event) or `204 No Content` (overwrite).

`X-BOOKING-HASH` is a private `X-` property; it is never returned to clients
through the Worker API and is only accessed by the Worker on `DELETE` to verify
the cancellation nonce.

### Delete event — `DELETE`

```http
DELETE {calendarUrl}/{uid}.ics HTTP/1.1
Authorization: Bearer {token}
```

Response: `204 No Content`.

### iCal parsing with `ical.js`

```typescript
import ICAL from "ical.js";

interface ParsedEvent {
  uid: string;
  summary: string;
  start: string;   // ISO 8601
  end: string;     // ISO 8601
}

function parseCalendarData(icsString: string): ParsedEvent[] {
  const jcal = ICAL.parse(icsString);
  const comp = new ICAL.Component(jcal);
  return comp.getAllSubcomponents("vevent").map(vevent => {
    const ev = new ICAL.Event(vevent);
    return {
      uid:     ev.uid,
      summary: ev.summary,
      start:   ev.startDate.toJSDate().toISOString(),
      end:     ev.endDate.toJSDate().toISOString(),
    };
  });
}
```

VEVENT generation is hand-rolled (~15 LOC); no library is needed for output.

### Google CalDAV deviations

The following Google-specific behaviours are known and must be accommodated
in `caldav.ts`. Each deviation is marked with a `// google-caldav:` comment
in the source.

| Deviation | Standard | Google behaviour |
| --- | --- | --- |
| Calendar URL | Per RFC 4791 principal discovery | Fixed: `https://apidata.googleusercontent.com/caldav/v2/{calId}/events/` |
| `calId` encoding | RFC 4791 | Must be URL-encoded (e.g. `@` → `%40`) |
| Auth scope | Server-dependent | `https://www.googleapis.com/auth/calendar` (not `calendar.events`) |
| `REPORT` depth | `Depth: 1` per spec | Requires `Depth: 1`; omitting it returns `400` |
| Time range format | `YYYYMMDDTHHmmssZ` | Same; no separators (dashes/colons) |
| Response ordering | Unspecified | Non-deterministic; do not rely on order |
| `ETag` on `PUT` | Optional optimistic lock | Google ignores `If-None-Match: *`; no conflict on PUT |

---

## 5. Slot Computation (Worker)

```typescript
interface ParsedEvent {
  uid: string;
  summary: string;
  start: string;
  end: string;
}

interface Slot {
  start: string;
  end: string;
  available: boolean;
}

function computeSlots(events: ParsedEvent[], slotMinutes: number): Slot[] {
  const openEvents   = events.filter(e => e.summary === "OPEN");
  const blockedTimes = events
    .filter(e => e.summary !== "OPEN")
    .map(e => ({ start: new Date(e.start), end: new Date(e.end) }));

  const slots: Slot[] = [];
  for (const open of openEvents) {
    let cursor = new Date(open.start);
    const openEnd = new Date(open.end);
    while (cursor.getTime() + slotMinutes * 60_000 <= openEnd.getTime()) {
      const slotEnd = new Date(cursor.getTime() + slotMinutes * 60_000);
      const blocked = blockedTimes.some(
        b => b.start < slotEnd && b.end > cursor
      );
      slots.push(
         {
               available: !blocked,
               start: cursor.toISOString(),
               end: slotEnd.toISOString() }
      );
      cursor = slotEnd;
    }
  }
  return slots;
}
```

This algorithm is very similar to the archived spike.
It now runs in the Worker rather than the SPA.

---

## 6. Worker Domain API

All error responses use RFC 9457 Problem Details with
`Content-Type: application/problem+json`:

```json
{ "type": "about:blank", "status": 400, "title": "Bad Request", "detail": "..." }
```

```text
GET /v1/challenge
  200: { "nonce": string, "difficulty": number, "expires_at": ISO8601 }
  — No auth required. Challenge valid for current + preceding 30-second window
    (~60 s total). Must be solved before POST /v1/bookings.

GET /v1/slots?start={ISO8601}&end={ISO8601}
  200: {
         "status": "success",
         "data": {
           "slots": {
             "YYYY-MM-DD": [{"start": string, "end": string}]
           }
         }
       }
  400: Problem Details — missing start/end
  502: Problem Details — CalDAV or auth failure

POST /v1/bookings
  Body: {
    "slot_start":       string,         // UTC ISO 8601, e.g. "2026-04-22T10:00:00.000Z"
    "attendee":         { "name": string (≤200), "email"?: string },
    "notes"?:           string (≤1000),
    "puzzle_nonce":     string,         // 64 base64url chars from GET /v1/challenge
    "puzzle_solution":  number          // uint32 satisfying the PoW condition
  }
  200: {
    "status": "success",
    "data": {
      "uid":                string,
      "start":              string,
      "end":                string,
      "cancellation_nonce": string      // 43 base64url chars; store for DELETE
    }
  }
  400: Problem Details — validation failure, puzzle wrong, or nonce expired
  409: Problem Details — slot taken
  429: Problem Details — rate limit exceeded
  502: Problem Details — CalDAV or auth failure

DELETE /v1/bookings/:uid
  Body: { "nonce": string }   // cancellation_nonce returned by POST
  204: (no body) — success
  400: Problem Details — missing or malformed nonce
  403: Problem Details — nonce does not match stored hash
  404: Problem Details — booking not found
  502: Problem Details — CalDAV or auth failure

OPTIONS /*
  204: CORS preflight

CORS headers emitted on all responses:
  Access-Control-Allow-Origin: http://localhost:5173 (dev)
                               https://bookings.pnr.iki.fi (prod)
  Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
  Access-Control-Allow-Headers: Content-Type
```

All other methods and paths return `405` or `404` Problem Details.

---

## 7. Frontend State Machine

Identical to the archived spike. Reproduced for completeness.

```text
                ┌────────┐
    page load   │  IDLE  │
   ─────────────►        │
                └───┬────┘
                    │ mount calendar
                    ▼
            ┌──────────────┐   fetch error
            │ LOADING_SLOTS├─────────────────► ERROR
            └──────┬───────┘
                   │ slots fetched
                   ▼
           ┌───────────────┐
           │ SHOWING_SLOTS │◄──── slot removed after booking
           └───────┬───────┘
                   │ eventClick
                   ▼
           ┌───────────────┐
           │ SLOT_SELECTED │
           │ (form shown)  ├──── dismiss ──────► SHOWING_SLOTS
           └───────┬───────┘
                   │ submit
                   ▼
           ┌───────────────┐
           │  CONFIRMING   │
           └──────┬────────┘
                  │
        ┌─────────┴──────────┐
        │ 200                │ 409 conflict
        ▼                    ▼
   ┌─────────┐        ┌────────────┐
   │CONFIRMED│        │ SLOT_TAKEN │
   └────┬────┘        │(Worker rolled back)
        │             └──────┬─────┘
        │                    │ acknowledge
        └─────────┬──────────┘
                  ▼
           SHOWING_SLOTS (re-fetch)
```

---

## 8. Concurrency / Double-Booking

The CalDAV `PUT` is not atomic relative to a concurrent `PUT` from another
session. The Worker's check-after-insert strategy (same as the archived spike)
handles this at the application level.

Race window: narrow for a low-traffic single-operator calendar. Accepted through
Stage 4. A Cloudflare Durable Object per-slot lock can be introduced if traffic
warrants it (Stage 6 candidate).

Note: Google CalDAV ignores `If-None-Match: *` on `PUT` (see §4 deviations),
so optimistic concurrency control via ETags is not available on Google.
Standard CalDAV servers (Nextcloud, Baïkal) do honour it; this may be used
in Stage 6.

---

## 9. Configuration Surface

### Local dev — `worker/.dev.vars` (gitignored)

```text
# Google auth — Method 1: service account (preferred)
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","client_email":"...","private_key":"..."}

# Google auth — Method 2: OAuth refresh token (fallback)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# Shared secrets
CALDAV_CALENDAR_URL=https://apidata.googleusercontent.com/caldav/v2/{calId}/events/
WORKER_NONCE_SECRET=<openssl rand -base64 32>
WORKER_PUZZLE_SECRET=<openssl rand -base64 32>
```

`SLOT_MINUTES`, `PUZZLE_DIFFICULTY`, and `PUZZLE_WINDOW_SECONDS` are set in
`worker/wrangler.toml [vars]` and are picked up automatically by `wrangler dev`.

### Production — secrets (`wrangler secret put`)

```text
GOOGLE_SERVICE_ACCOUNT_JSON   (pipe from file — do not paste interactively)
CALDAV_CALENDAR_URL
WORKER_NONCE_SECRET
WORKER_PUZZLE_SECRET
```

Rotating `WORKER_NONCE_SECRET` invalidates all existing `cancellation_nonce`
values stored in customers' `localStorage`; outstanding bookings can still be
cancelled by the operator via their CalDAV client.

### Production — `wrangler.toml [vars]` (committed, visible)

```toml
[vars]
SLOT_MINUTES          = "30"
PUZZLE_DIFFICULTY     = "10"
PUZZLE_WINDOW_SECONDS = "30"

[[rate_limiting]]
binding      = "BOOKING_RL"
namespace_id = "1"
simple       = { limit = 5, period = 60 }
```

Rate limit parameters are baked into the binding at deploy time; edit and
redeploy to change them. The `BOOKING_RL` binding is absent in `wrangler dev`;
the Worker skips rate limiting locally.

### SPA (Vite build-time)

```text
VITE_WORKER_URL=https://booking-worker.pekka-nikander.workers.dev
```

Injected via GitHub Actions workflow env at build time. Falls back to
`http://localhost:8787` when the env var is unset (local dev).

### Live URLs (Stage 4)

```text
Frontend: https://bookings.pnr.iki.fi
Worker:   https://booking-worker.pekka-nikander.workers.dev
```

---

## 10. Long-term direction — informative

The current design (SPA + thin Worker + CalDAV backend) reflects the present-day constraints of the web platform rather than an ideal architecture.

In particular, the browser cannot safely hold long-lived credentials or call third-party APIs directly in a general way. Cross-origin restrictions (CORS), the use of bearer tokens, and the lack of fine-grained delegation mechanisms mean that even simple integrations typically require a small server-side component to hold secrets and mediate requests.

The Worker in this design plays exactly that role: it is a minimal bridge that translates a simple JSON API into CalDAV operations and holds the necessary credentials. This is intentionally kept as small and stateless as possible.

A plausible long-term direction for the web would reduce or eliminate the need for such bridges. The building blocks for this are emerging, but not yet integrated:

- Passkeys / WebAuthn provide device-bound cryptographic identities in the browser.
- OAuth evolution (including proof-of-possession approaches such as DPoP) points toward access tokens bound to client-held keys rather than bearer tokens.
- Device attestation mechanisms (including work around ACME device attestation) explore how devices can prove properties about themselves and obtain credentials.

Taken together, these suggest a future in which a browser could hold a device-bound key and receive narrowly scoped, verifiable capabilities that can be used directly against service APIs without an intermediary server.

This project does not attempt to implement such a system. Instead, it adopts a pragmatic intermediate step:

- keep the frontend simple and static,
- centralise authority in a very small Worker component,
- use open protocols (CalDAV, iCalendar) for persistence,
- and expose a narrow, well-defined domain API.

In that sense, the current architecture can be seen as a “baby step” toward a more direct and composable web, where the role of the Worker could eventually shrink further or disappear as the underlying standards evolve.

A potential next baby step might be to implement DPoP in a separate service worker for the SPA, protecting the traffic between the browser and the Cloudflare worker.  Filip Skokan's (panva), the author of jose, has a Github repo https://github.com/panva/dpop that could be very useful here.
