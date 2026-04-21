# Booking Calendar — Architecture

> Produced at end of Stage 1. Revise when stage findings change any decision.

---

## 1. Component Diagram

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Operator's device                                                  │
│  Calendar.app / iOS Calendar                                        │
│    └── creates OPEN events in Google Calendar                       │
└───────────────────────────────────────────┬─────────────────────────┘
                                            ^
                                            │ HTTPS
                                            ▼
                                   ┌────────────────────────┐
                                   │  Google Calendar API   │
                                   │  (single calendar)     │
                                   └────────┬───────────────┘
                                            ^
                                            │ HTTPS
                                            ▼
┌─────────────────────────────┐    ┌────────────────────────┐
│  GitHub Pages               │    │  Cloudflare Worker     │
│  (static SPA)               │    │  (auth proxy only)     │
│                             │    │                        │
│  FullCalendar timeGridWeek  │    │  • get / cache token   │
│  Slot computation (client)  │◄──►│  • add Authorization   │
│  Booking logic (client)     │    │    header              │
│  calendar.ts                │    │  • forward verbatim    │
│  booking.ts                 │    │  • add CORS headers    │
│  api.ts                     │    │                        │
└─────────────────────────────┘    └────────────────────────┘
```

The Worker has no knowledge of OPEN events, BOOKED events, or slots.
It is a pure CORS-plus-auth proxy.

---

## 2. Data Flow

### Operator paints availability

1. Operator opens Calendar.app or iOS Calendar.
2. Creates an event titled exactly `OPEN` spanning the available window
   (e.g. 09:00–17:00). Duration may be longer than one bookable slot.
3. Event is directly saved to the designated Google Calendar.
   The SPA or Worker are not involved.

### Customer views available slots

1. Browser loads the SPA from GitHub Pages.
2. SPA calls `GET /calendar/v3/calendars/{calId}/events` (via Worker proxy)
   with `timeMin`, `timeMax`, `singleEvents=true`.
3. Worker adds `Authorization: Bearer {token}` and forwards; returns response
   verbatim.
4. SPA receives all events. Client-side logic:
   - Collect OPEN events: `event.summary === "OPEN"`.
   - Collect blocked events: all others.
   - For each OPEN event, generate sub-slots of `SLOT_MINUTES` (e.g. 60 min),
     aligned to the slot boundary, within the OPEN event's time range.
   - Remove any sub-slot that overlaps with a blocked event's time range.
5. SPA renders remaining sub-slots as clickable events in FullCalendar.

### Customer books a slot

1. Customer clicks a slot; a minimal inline form appears (name field, confirm button).
2. On confirm, SPA calls `POST /calendar/v3/calendars/{calId}/events` (via
   Worker) to insert a BOOKED event:
   - `summary`: customer name
   - `description`: fixed string
   - `start.dateTime`: slot start (ISO 8601)
   - `end.dateTime`: slot end (ISO 8601)
   - `colorId`: "11" (tomato — visually distinguishes bookings)
3. Google Calendar returns the created event; SPA records the `id`.
4. SPA immediately calls `GET /calendar/v3/calendars/{calId}/events` with
   `timeMin=slotStart&timeMax=slotEnd&singleEvents=true`.
5. SPA inspects the returned events:
   - Ignore the just-inserted BOOKED event (by `id`).
   - If any other non-OPEN event overlaps the slot window → conflict.
6a. No conflict: remove the slot from FullCalendar view; show confirmation.
6b. Conflict: call `DELETE /calendar/v3/calendars/{calId}/events/{id}` (via
    Worker) to roll back; show "sorry, this slot was just taken".

### OPEN event lifecycle

OPEN events are never modified or deleted by the SPA or Worker.
After the availability window fills with BOOKED events, the OPEN event remains
in the calendar but produces no available sub-slots.

---

## 3. Google Calendar Credential Approach

### Choice: service account

A service account is a GCP principal (not a human user). The operator:

1. Creates a GCP project (free; a personal Google account suffices — no
   Google Workspace subscription required).
2. Enables the Google Calendar API in that project.
3. Creates a service account; downloads a JSON key file.
4. Shares the target Google Calendar with the service account email address
   (permission: "Make changes to events", i.e. Writer role).

The Worker holds the JSON key as a secret env var. No human OAuth flow.

For documentation for the operator, use `docs/GOOGLE_SETUP.md` (to be created).

### OAuth scope

`https://www.googleapis.com/auth/calendar.events`

This is the minimum scope that allows both reading events (to compute slots
and check conflicts) and writing events (to insert and delete BOOKED events).
A narrower write-only scope does not exist; see §3a below.

### JWT flow in the Worker (Web Crypto API)

```text
1. Parse GOOGLE_SERVICE_ACCOUNT_JSON → { client_email, private_key }
2. Strip PEM headers from private_key; base64-decode to ArrayBuffer.
3. crypto.subtle.importKey("pkcs8", keyBuffer,
     { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
4. Build JWT: header.claims (base64url-encoded)
   Claims: iss=client_email, scope=..., aud=https://oauth2.googleapis.com/token,
           iat=now, exp=now+3600
5. crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(header.claims))
6. JWT = header.claims.base64url(signature)
7. POST https://oauth2.googleapis.com/token
   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={JWT}
8. Cache returned access_token in a module-level variable with its expiry.
   (Worker process restarts reset the cache; acceptable for spike.)
```

No external library required. ~50 LOC in TypeScript.

### 3a. Security analysis: credential design and attack surface

#### Context

The operator owns the personal Google Calendar; the Worker authenticates as a
separate service account (SA). The operator shares the target calendar with the
SA. The SA credential must never appear in the SPA bundle — the Worker holds it
as a server-side secret.

The Worker is a transparent proxy with no application-level authentication.
CORS headers restrict browser-origin requests, but CORS is a browser control
only: an attacker can make arbitrary HTTP requests to the Worker URL directly
(e.g. `curl`) and bypass CORS entirely. The attacker's actual capability is
therefore determined solely by what the Worker's credentials permit on the
Google Calendar API, not by any Worker-side gate.

#### Single-credential analysis (`calendar.events` scope)

With one SA using `calendar.events` scope and Writer calendar sharing:

| Operation | Possible? | Impact |
| --- | --- | --- |
| Read all events | Yes | PII leak: customer names in BOOKED event summaries/descriptions |
| Insert events | Yes | Fake BOOKEDs occupy slots inside OPEN windows; invisible pollution outside them |
| Delete any event | Yes | Delete OPEN events (erase availability); delete legitimate bookings |
| Patch any event | Yes | Modify OPEN or BOOKED event content or times |
| Access other calendars | No | SA only has access to calendars explicitly shared with it |
| Access other Google services | No | Scope is `calendar.events` on Calendar API only |

#### Two-credential approach

The read and write concerns can be separated with two service accounts:

- **SA-A** — calendar Reader sharing + `calendar.events.readonly` scope.
  Reads all events; cannot create, modify, or delete anything.
- **SA-B** — calendar Writer sharing + `calendar.events.owned` scope.
  Creates events (which become SA-B-owned); can modify/delete only those events.
  Cannot touch events owned by others (including the operator's OPEN events).

The Worker uses SA-A tokens for GET requests and SA-B tokens for
POST/DELETE/PATCH requests.

| Threat | Single SA | Two-SA | Notes |
| --- | --- | --- | --- |
| Read all events (PII) | Yes | Yes | SA-A has read-only access to all events; unavoidable |
| Delete OPEN events | Yes | **No** | SA-B cannot modify events it does not own |
| Modify OPEN events | Yes | **No** | Same reason |
| Create fake BOOKED events | Yes | Yes | SA-B can create events; see below |
| Delete legitimate BOOKED events | Yes | Yes | All BOOKEDs are SA-B-owned; see below |
| Modify legitimate BOOKED events | Yes | Yes | Same reason |

The two-SA approach provides one concrete improvement: **OPEN events are
protected** from modification and deletion via the Worker API. All other attack
surfaces remain.

#### Why fake BOOKED creation is a limited threat

Fake BOOKED events inserted inside an OPEN window occupy slots and suppress
them from the SPA display. The operator sees the spurious events in Calendar.
The same attack is available to anyone with direct Google Calendar access — the
Worker does not introduce a qualitatively new vector. Fake BOOKEDs outside OPEN
windows are ignored by the slot computation.

The only structurally preventable _create_ attack is **double-booking** (two
legitimate customers racing for the same slot). The current check-after-insert
plus rollback flow handles this at the client side; a proper per-slot lock is
deferred to Stage 4 (Durable Objects).

#### BOOKED event deletion: chosen mitigation

The SPA must be able to delete the BOOKED event it just created (race-condition
rollback). The Worker must therefore expose DELETE. Because the Worker is
stateless and has no session concept, it cannot distinguish "the browser that
created this booking" from an attacker who listed all event IDs via SA-A and
is now issuing DELETEs via SA-B.

Chosen mitigation (to be implemented in Stage 4):

1. On booking creation, the SPA generates a cryptographically random nonce and
   stores it locally (localStorage, keyed by event ID).
2. The SPA computes `SHA-256(nonce)` and passes the hex digest to the Worker
   directly as part of the create request.
3. The Worker passes the digest in the new event's `extendedProperties.private`
   field to Google (invisible in Calendar.app and the web UI; readable only via SA-B
   credentials). No Worker-held secret or logic is required here.
4. On DELETE, the SPA presents the raw nonce. The Worker reads the event,
   recomputes `SHA-256(nonce)`, compares against the stored digest, and
   proxies the DELETE only if they match. This costs one extra API read
   per deletion.

PATCH and PUT are not needed: any "change booking" feature in Stage 4 is
modelled as delete-old + create-new rather than a patch. The Worker
explicitly rejects PATCH and PUT with 405.

Accepted drawback: a booking can only be deleted (via the Worker) from the
browser that created it. Deletion from a different browser or device is not
possible through the SPA — the operator can still delete bookings directly in
Calendar.app.

#### Summary of Google-side restrictions

| Restriction | Single SA | Two-SA | Notes |
| --- | --- | --- | --- |
| Restrict by source IP | No | No | SA JSON keys have no network-level enforcement |
| Restrict by HTTP referer | No | No | SA JWT exchange is server-to-server; referer not evaluated |
| GCP IAM conditions | No | No | Calendar API is a Google Workspace API, not a GCP resource |
| `calendar.events.owned` write credential | N/A | Partial | Protects OPEN events; BOOKED events are still SA-B-owned and deletable |
| Append-only calendar ACL | No | No | Calendar sharing is Owner/Writer/Reader only |
| Short-lived embedded token | No | No | Token refresh requires the secret regardless |

#### Verdict

The two-SA credential design should be used for production. It materially
reduces the blast radius: OPEN events (operator availability) cannot be
modified or deleted via the Worker API.

Residual risks accepted at this stage:

- PII exposure via the read credential (all BOOKED event details are readable).
- Fake BOOKED creation within OPEN windows (nuisance-level; same capability
  exists via direct Calendar access).

Embedding any SA credential in the SPA remains **not acceptable for
production**: the key never leaves the server-side Worker environment.

---

## 4. Worker API Surface (Spike)

The Worker is a transparent auth proxy with no application logic:

```text
ANY /*
    → transparent proxy to https://www.googleapis.com/calendar/v3/*

Request handling:
  1. Obtain (or return cached) Google access token via service account JWT flow.
  2. Copy all headers from the incoming request.
  3. Add/replace Authorization: Bearer {access_token}.
  4. Forward request to https://www.googleapis.com + request.url (path + query).
  5. Return response body and status verbatim.
  6. Add CORS headers to the response.

OPTIONS preflight:
  Return 204 with CORS headers.

CORS headers emitted:
  Access-Control-Allow-Origin: http://localhost:5173 (dev)
                               https://<subdomain>.pnr.iki.fi (prod)
  Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
  Access-Control-Allow-Headers: Content-Type, Authorization

PATCH and PUT return 405; no use case exists and they are excluded
from the allowed surface to reduce the attack area.
```

The SPA constructs full Google Calendar API paths. Example calls made by SPA:

```text
GET  /calendar/v3/calendars/{calId}/events?timeMin=...&timeMax=...&singleEvents=true
POST /calendar/v3/calendars/{calId}/events          (insert BOOKED event)
GET  /calendar/v3/calendars/{calId}/events?timeMin=slotStart&timeMax=slotEnd
DELETE /calendar/v3/calendars/{calId}/events/{id}   (rollback on conflict)
```

After the spike, application logic (conflict checking, slot computation) may be
moved into the Worker to form a proper API surface. This is deferred to Stage 4.

---

## 5. Frontend State Machine

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
        │ no conflict        │ conflict found
        ▼                    ▼
   ┌─────────┐        ┌────────────┐
   │CONFIRMED│        │ SLOT_TAKEN │
   └────┬────┘        │(auto-rollback)
        │             └──────┬─────┘
        │                    │ acknowledge
        └─────────┬──────────┘
                  ▼
           SHOWING_SLOTS (re-fetch)
```

---

## 6. Concurrency / Double-Booking Strategy

The booking flow is not atomic (Google Calendar has no transaction support).
Race condition:

```text
Customer A: insert BOOKED_A ──► list events ──► no conflict ──► success
Customer B:    insert BOOKED_B ──► list events ──► no conflict ──► success
Result: two bookings for the same slot.
```

For the spike this is acceptable: the probability is very low on a
single-operator low-traffic calendar, and the consequences are manageable
(operator notices and contacts one customer).

In Stage 4, if needed: a Cloudflare Durable Object can provide a
per-slot exclusive lock.

---

## 7. Configuration Surface

### Spike configuration (all hardcoded or in local secrets file)

```text
Worker — .dev.vars (gitignored; never committed):
  GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","client_email":"...","private_key":"..."}
  GOOGLE_CALENDAR_ID=abc123@group.calendar.google.com

SPA — hardcoded constants in src/config.ts:
  export const WORKER_URL   = "http://localhost:8787";
  export const CALENDAR_ID  = "abc123@group.calendar.google.com";
  export const SLOT_MINUTES = 60;
```

`CALENDAR_ID` is not a secret (it looks like an email address; knowledge of it
alone does not grant calendar access). Safe to hardcode in SPA source.

### Stage 3+ (GitHub Pages + Cloudflare deploy)

```text
Worker secrets (set via wrangler secret put):
  GOOGLE_SERVICE_ACCOUNT_JSON
  GOOGLE_CALENDAR_ID

Worker env vars (in wrangler.toml [vars]):
  ALLOWED_ORIGIN = "https://<subdomain>.pnr.iki.fi"

SPA (Vite build-time env, .env.production):
  VITE_WORKER_URL=https://booking-worker.<account>.workers.dev
  VITE_CALENDAR_ID=abc123@group.calendar.google.com
  VITE_SLOT_MINUTES=60
```
