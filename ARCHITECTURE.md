# Booking Calendar — Architecture (CalDAV)

> Produced at end of Stage 1. Supersedes the archived Google REST API version
> at `archive/spike-google-calendar/ARCHITECTURE.md`.
> Revise when stage findings change any decision.

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
2. SPA calls `POST /v1/bookings` with a Cal.com-inspired but reduced JSON body such as `{start, attendee: {name, email}, notes}`.
3. Worker:
   a. Generates a UUID as the event UID.
   b. Builds a `VEVENT` iCal string (see §4).
   c. Issues a CalDAV `PUT` to `{calendarUrl}/{uid}.ics`.
   d. Issues a CalDAV `REPORT` for the same time window to check for
      conflicts (any non-OPEN event other than the just-created one).
   e. If conflict: issues `DELETE` for the just-created event; returns
      `409 Conflict`.
   f. If no conflict: returns `200` with a Cal.com-shaped but reduced success object such as `{status: "success", data: {uid, start, end}}`.
4. SPA receives response:
   - Success: shows booked slot at FullCalendar view; shows confirmation.
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
- **OAuth2** (future): Nextcloud supports OAuth2; integration deferred to
  Stage 4.

The `auth.ts` module will be extended in Stage 4 to support Basic auth as an
alternative to the service account JWT flow, selected by a Worker env var.

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

#### Fake booking creation

`POST /v1/bookings` is public. An attacker can submit arbitrary bookable
times within an OPEN window to occupy slots. Mitigation: rate limiting on
`POST /v1/bookings` (deferred to Stage 4). The fake bookings are visible to
the operator in their calendar client, so the attack is not silent.

#### Booking deletion — nonce mitigation (Stage 4)

The Worker must be able to delete a booking it just created (conflict
rollback). Exposing `DELETE /bookings/:uid` with no gate means an attacker
who discovers a UID can delete legitimate bookings.

Chosen mitigation (Stage 4):

1. On `POST /v1/bookings`, the Worker generates a cryptographically random nonce and
   stores its `SHA-256` hex digest in the `VEVENT`'s `X-BOOKING-HASH`
   property before `PUT`-ing to the CalDAV server.
2. The Worker returns the raw nonce to the SPA in the `POST /book` response;
   the SPA stores it in `localStorage` keyed by UID.
3. On `DELETE /bookings/:uid`, the SPA presents the nonce. The Worker fetches
   the event, recomputes the hash, and only proxies the `DELETE` if they match.

This costs one extra CalDAV `GET` per deletion. It means a booking can only
be deleted (via the Worker) from the browser session that created it.
Operator-side deletion via the CalDAV client (Calendar.app, etc.) is always
available.

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
END:VEVENT
END:VCALENDAR
```

Response: `201 Created` (new event) or `204 No Content` (overwrite).

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

```text
GET /v1/slots?start={ISO8601}&end={ISO8601}
  200: {
         status: "success",
         data: {
           slots: {
             "YYYY-MM-DD": [{start: string, end: string, available: boolean}]
           }
         }
       }
  400: {status: "error", error: {code: "bad_request", message: "missing start/end"}}
  502: {status: "error", error: {code: "caldav_error", message: "caldav error"}}

POST /v1/bookings
  Body: {
          start: string,
          attendee: {name: string, email?: string},
          notes?: string
        }
  200: {status: "success", data: {uid: string, start: string, end: string}}
  409: {status: "error", error: {code: "conflict", message: "slot taken"}}
  400: {status: "error", error: {code: "bad_request", message: "invalid body"}}

DELETE /v1/bookings/:uid
  204: (no body)
  404: {status: "error", error: {code: "not_found", message: "not found"}}

OPTIONS /*
  204: CORS preflight

CORS headers emitted on all responses:
  Access-Control-Allow-Origin: http://localhost:5173 (dev)
                               https://<subdomain>.pnr.iki.fi (prod)
  Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
  Access-Control-Allow-Headers: Content-Type
```

All other methods and paths return `405` or `404`.

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

Race window: narrow for a low-traffic single-operator calendar. Accepted for
the spike and Stage 3. Stage 4 can introduce a Cloudflare Durable Object
per-slot lock if traffic warrants it.

Note: Google CalDAV ignores `If-None-Match: *` on `PUT` (see §4 deviations),
so optimistic concurrency control via ETags is not available on Google.
Standard CalDAV servers (Nextcloud, Baïkal) do honour it; this may be used
in Stage 4.

---

## 9. Configuration Surface

### Spike (local dev)

```text
Worker — worker/.dev.vars (gitignored):
  # Method 1 — service account (preferred; used when present)
  GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","client_email":"...","private_key":"..."}

  # Method 2 — user OAuth refresh token (fallback)
  GOOGLE_CLIENT_ID=...
  GOOGLE_CLIENT_SECRET=...
  GOOGLE_REFRESH_TOKEN=...

  # Shared
  CALDAV_CALENDAR_URL=https://apidata.googleusercontent.com/caldav/v2/{calId}/events/
  SLOT_MINUTES=30

SPA — hardcoded in frontend/src/config.ts:
  export const WORKER_URL = "http://localhost:8787";
```

`SLOT_MINUTES` has moved from the SPA to the Worker because slot computation
now runs server-side.

### Stage 3+ (production)

```text
Worker secrets (wrangler secret put):
  GOOGLE_SERVICE_ACCOUNT_JSON   (spike)
  CALDAV_PASSWORD               (Stage 4 non-Google, Basic auth)

Worker env vars (wrangler.toml [vars]):
  CALDAV_CALENDAR_URL=https://...
  CALDAV_AUTH_TYPE=service_account | basic
  CALDAV_USERNAME=...           (Stage 4, Basic auth)
  SLOT_MINUTES=60
  ALLOWED_ORIGIN=https://<subdomain>.pnr.iki.fi

SPA (Vite build-time, .env.production):
  VITE_WORKER_URL=https://booking-worker.<account>.workers.dev
```

The frontend remains responsible for adapting the simplified Cal.com-shaped responses into FullCalendar events.

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
