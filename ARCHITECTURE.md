# Booking Calendar — Architecture (UCAN Spike)

> Produced for the UCAN security spike.
> Revise when stage findings change any decision.

The security architecture — principals, resources, capabilities, delegation
flows, and open questions — is documented separately in
`SECURITY-ARCHITECTURE.md`. This document covers the system architecture and
implementation-level concerns.

---

## 1. Component Diagram

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Practitioner's device                                              │
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
┌──────────────────────────────────┐    ┌────────────────────────────┐
│  GitHub Pages                    │    │  Cloudflare Worker         │
│  (static SPA)                    │    │  (domain API)              │
│                                  │    │                            │
│  Service Worker (sw.ts)          │    │  GET  /v1/slots            │
│  • P-256 key pair → did:key:SPA  │    │  POST /v1/bookings         │
│  • signs UCAN invocations        │    │  DELETE /v1/bookings/:uid  │
│  • stores delegation tokens      │    │                            │
│    in IndexedDB                  │    │  Internally:               │
│                                  │    │  • UCAN validation         │
│  FullCalendar timeGridWeek  ◄────┼──► │  • CalDAV auth (JWT/OAuth) │
│  Booking form                    │    │  • CalDAV REPORT/PUT/      │
│  api.ts (JSON + UCAN)            │    │    DELETE/GET              │
│                                  │    │  • ical.js parsing         │
│                                  │    │  • slot computation        │
└──────────────────────────────────┘    └────────────────────────────┘
```

The physical topology is unchanged from the previous spike. The security layer
is replaced: DPoP proofs, proof-of-work puzzles, and HMAC cancellation nonces
are removed; UCAN delegation and invocation tokens take their place.

---

## 2. Data Flow

### Practitioner paints availability

Unchanged. The practitioner creates events titled exactly `OPEN` in the
designated CalDAV calendar using any CalDAV client. The Worker and SPA are not
involved. OPEN events may span longer than a single bookable slot.

### Customer views available slots

1. Browser loads the SPA from GitHub Pages. `main.ts` waits for the Service
   Worker to activate and claim the page before proceeding.
2. The Service Worker generates (on first activation) or loads (on subsequent
   loads) a non-extractable EC P-256 key pair from IndexedDB. The public key
   is encoded as `did:key:SPA-i`.
3. SPA calls `GET /v1/slots?start={ISO8601}&end={ISO8601}` with an
   `X-UCAN-DID: did:key:SPA-i` header identifying the session principal.
4. Worker:
   a. Obtains (or returns cached) CalDAV access token.
   b. Issues a CalDAV `REPORT` with a time-range filter.
   c. Parses the `207 Multi-Status` XML response; extracts `VEVENT` data.
   d. Separates `SUMMARY=OPEN` events from blocked events.
   e. Runs slot computation (see §5).
   f. For each available slot, signs a UCAN `booking/create` delegation
      targeted at `did:key:SPA-i`, expiring in e.g. 30 minutes.
   g. Returns slots as JSON alongside the per-slot delegation tokens.
5. SPA renders available slots as clickable events in FullCalendar and stores
   the delegation tokens in IndexedDB keyed by slot start time.

### Customer books a slot

1. Customer clicks a slot; a minimal inline form appears.
2. SPA signs a UCAN invocation token: ability `booking/create` on
   `slot:<domain>/<uid>`, issued by `did:key:SPA-i`, audience `did:key:W`,
   expiring in 60 seconds, carrying the delegation from step 4f as proof.
3. SPA calls `POST /v1/bookings` with booking details and the UCAN invocation.
4. Worker:
   a. Checks IP rate limit.
   b. Validates all input fields.
   c. Validates the UCAN invocation and proof chain:
      - delegation is signed by Worker's own key
      - delegation targets `did:key:SPA-i`
      - invocation is signed by `did:key:SPA-i`
      - invocation ability and resource match the delegation
      - neither token has expired
      - invocation `iat` is within the freshness window
   d. Checks the slot is still available (CalDAV REPORT).
   e. Generates a UUID; writes the booking VEVENT to CalDAV (PUT).
   f. Re-checks for conflicts (CalDAV REPORT); rolls back (DELETE) and
      returns `409` if another booking raced in.
   g. Signs and returns a UCAN `booking/delete` delegation:
      ability `booking/delete` on `booking:<domain>/<uid>`,
      targeted at `did:key:SPA-i`, expiring at booking time + grace.
5. SPA stores the `booking/delete` delegation in IndexedDB keyed by `uid`,
   removes the slot from the calendar view, and shows a confirmation.

### Customer cancels a booking

1. SPA loads the `booking/delete` delegation for `uid` from IndexedDB.
2. SPA signs a UCAN invocation: ability `booking/delete` on
   `booking:<domain>/<uid>`, proof = the stored delegation.
3. SPA calls `DELETE /v1/bookings/:uid` with the invocation.
4. Worker validates the chain; deletes the VEVENT from CalDAV; returns `204`.

---

## 3. Security Implementation

Full principal/resource/capability model in `SECURITY-ARCHITECTURE.md`.

### 3.1 Worker DID and signing key

The Worker holds a stable EC P-256 key pair as Cloudflare Secrets:
`WORKER_UCAN_PRIVATE_KEY` (PKCS8, base64url) and `WORKER_UCAN_PUBLIC_KEY` (raw,
base64url). The Worker DID `did:key:W` is derived from the public key at
startup. This key is used exclusively for signing UCAN delegation tokens.

Rotating this key invalidates all outstanding delegation tokens held by
clients. See `SECURITY-ARCHITECTURE.md §10.9`.

### 3.2 SPA session DID

The Service Worker generates a non-extractable P-256 key pair using the same
approach as the previous spike (generate extractable, export public JWK,
re-import private key as non-extractable). The public key is encoded as a
`did:key` DID and stored in IndexedDB alongside the key pair.

The DID is included as `X-UCAN-DID` in all requests to the Worker. CORS
headers must expose this header in both directions.

### 3.3 UCAN token format

Targeting UCAN 0.10 JWT with inline proof chain embedding. See
`SECURITY-ARCHITECTURE.md §9` for options and rationale. Tokens are signed
with ES256 (ECDSA P-256) throughout.

Delegation token structure:

```json
Header: { "alg": "ES256", "typ": "JWT", "ucv": "0.10.0" }
Payload: {
  "iss": "did:key:W",
  "aud": "did:key:SPA-i",
  "exp": 1234567890,
  "att": [{ "with": "slot:bookings.pnr.iki.fi/<uid>",
             "can": "booking/create" }],
  "prf": []
}
```

Invocation token structure:

```json
Header: { "alg": "ES256", "typ": "JWT", "ucv": "0.10.0" }
Payload: {
  "iss": "did:key:SPA-i",
  "aud": "did:key:W",
  "exp": now + 60,
  "iat": now,
  "att": [{ "with": "slot:bookings.pnr.iki.fi/<uid>",
             "can": "booking/create" }],
  "prf": [ "<delegation JWT from Worker>" ]
}
```

With inline embedding, `prf` carries the full delegation token strings rather
than CID references. The Worker reads the embedded tokens directly from the
invocation rather than resolving them from a store.

### 3.4 UCAN validation (Worker)

Validation order on any write request:

1. Check IP rate limit (cheapest).
2. Parse invocation token; reject if malformed.
3. Verify invocation signature against the DID in `iss`.
4. Check invocation `exp` not past; check `iat` within freshness window.
5. Parse the embedded proof delegation(s) from `prf`.
6. Verify each delegation signature against its `iss` DID.
7. Walk the chain: verify the root delegation's `iss` matches the Worker DID.
8. Verify that each delegation's `att` capability is not exceeded by the next
   token in the chain (attenuation check).
9. Verify the invocation's `att` matches the terminal delegation's `att`.
10. Proceed with the operation.

### 3.5 Rate limiting

Cloudflare's built-in rate limit binding applies to `GET /v1/slots` (delegation
issuance) and `POST /v1/bookings` (booking creation). Limiting delegation
issuance per IP prevents bulk pre-fetching of booking rights.

---

## 4. CalDAV Wire Format

Unchanged from the previous spike. The Worker still uses CalDAV REPORT to
list events, PUT to create bookings, DELETE to remove them, and GET to fetch
an individual event. The `X-BOOKING-HASH` custom property on VEVENT objects is
no longer needed (cancellation is UCAN-gated) and is not written.

For reference:

**REPORT** — `calendar-query` with `time-range` filter, `Depth: 1`,
`Authorization: Bearer {token}`. Response is `207 Multi-Status`; each
`<d:response>` contains `<c:calendar-data>` with a VCALENDAR string.

**PUT** — creates or overwrites `{calendarUrl}/{uid}.ics` with a VEVENT:

```
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

**DELETE** — `DELETE {calendarUrl}/{uid}.ics`.

**iCal parsing** uses `ical.js`; generation is hand-rolled.

Google CalDAV deviations (URL encoding of calendar ID, required `Depth: 1`,
ignored `If-None-Match`) apply as documented in the archived spike.

---

## 5. Slot Computation (Worker)

Unchanged from the previous spike. The Worker:

1. Partitions VEVENT objects: `SUMMARY=OPEN` → availability windows; all
   others → blocked spans.
2. For each availability window, walks a cursor in `SLOT_MINUTES` increments,
   emitting a slot for each sub-span not overlapped by a blocked event.

```typescript
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
      const blocked = blockedTimes.some(b => b.start < slotEnd && b.end > cursor);
      slots.push({ available: !blocked, start: cursor.toISOString(), end: slotEnd.toISOString() });
      cursor = slotEnd;
    }
  }
  return slots;
}
```

---

## 6. Worker Domain API

All error responses use RFC 9457 Problem Details with
`Content-Type: application/problem+json`:

```json
{ "type": "about:blank", "status": 400, "title": "Bad Request", "detail": "..." }
```

```text
GET /v1/slots?start={ISO8601}&end={ISO8601}
  Headers: X-UCAN-DID: did:key:SPA-i
  200: {
    "status": "success",
    "data": {
      "slots": {
        "YYYY-MM-DD": [{ "start": string, "end": string }]
      },
      "delegations": {
        "<slot-uid>": "<UCAN delegation JWT>"
      }
    }
  }
  400: Problem Details — missing/invalid start or end
  429: Problem Details — rate limit exceeded (delegation issuance)
  502: Problem Details — CalDAV or auth failure

POST /v1/bookings
  Body: {
    "slot_start": string,          // UTC ISO 8601
    "attendee":   { "name": string (≤200), "email"?: string },
    "notes"?:     string (≤1000),
    "ucan":       string           // UCAN invocation JWT (booking/create)
  }
  200: {
    "status": "success",
    "data": {
      "uid":         string,
      "start":       string,
      "end":         string,
      "ucan_delete": string        // UCAN delegation JWT (booking/delete)
    }
  }
  400: Problem Details — validation failure
  401: Problem Details — invalid or expired UCAN invocation
  403: Problem Details — UCAN chain verification failed
  409: Problem Details — slot taken
  429: Problem Details — rate limit exceeded
  502: Problem Details — CalDAV or auth failure

DELETE /v1/bookings/:uid
  Body: { "ucan": string }         // UCAN invocation JWT (booking/delete)
  204: (no body) — success
  400: Problem Details — missing or malformed body
  401: Problem Details — invalid or expired UCAN invocation
  403: Problem Details — UCAN chain verification failed
  404: Problem Details — booking not found
  502: Problem Details — CalDAV or auth failure

OPTIONS /*
  204: CORS preflight

CORS headers on all responses:
  Access-Control-Allow-Origin:   http://localhost:5173 (dev)
                                 https://bookings.pnr.iki.fi (prod)
  Access-Control-Allow-Methods:  GET, POST, DELETE, OPTIONS
  Access-Control-Allow-Headers:  Content-Type, X-UCAN-DID
  Access-Control-Expose-Headers: (none required by default)
```

The `/v1/challenge` endpoint is removed (no puzzle).

---

## 7. Frontend State Machine

The top-level state machine is unchanged from the previous spike:

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
                   │ slots + delegations fetched
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
   └────┬────┘        └──────┬─────┘
        │                    │ acknowledge
        └─────────┬──────────┘
                  ▼
           SHOWING_SLOTS (re-fetch)
```

The booking flow builds a UCAN invocation token (rather than solving a PoW
puzzle before submitting. No `GET /v1/challenge` call is needed.)

---

## 8. Concurrency / Double-Booking

Unchanged. CalDAV `PUT` is not atomic relative to concurrent `PUT` from another
session. The Worker's check-after-insert strategy handles this at the
application level. Race window is narrow at low traffic. Cloudflare Durable
Objects per-slot lock remains a post-spike option.

---

## 9. Configuration Surface

### Local dev — `worker/.dev.vars` (gitignored)

```text
# CalDAV credentials (same as previous spike)
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","client_email":"...","private_key":"..."}
CALDAV_CALENDAR_URL=https://apidata.googleusercontent.com/caldav/v2/{calId}/events/

# Worker UCAN signing key (generate once: openssl ecparam -genkey -name prime256v1 ...)
WORKER_UCAN_PRIVATE_KEY=<base64url-encoded PKCS8 private key>
WORKER_UCAN_PUBLIC_KEY=<base64url-encoded uncompressed public key>
```

### Production — secrets (`wrangler secret put`)

```text
GOOGLE_SERVICE_ACCOUNT_JSON
CALDAV_CALENDAR_URL
WORKER_UCAN_PRIVATE_KEY
WORKER_UCAN_PUBLIC_KEY
```

Rotating `WORKER_UCAN_PRIVATE_KEY` invalidates all outstanding UCAN delegation
tokens held by clients. Bookings can still be cancelled by the practitioner
via CalDAV. There is no graceful rotation path without key versioning (see
`SECURITY-ARCHITECTURE.md §10.9`).

### `wrangler.toml [vars]` (committed, visible)

```toml
[vars]
SLOT_MINUTES              = "30"
UCAN_DELEGATION_TTL_SECS  = "1800"   # booking/create delegation lifetime
UCAN_INVOCATION_MAX_AGE   = "60"     # max seconds between iat and validation
UCAN_WORKER_DOMAIN        = "bookings.pnr.iki.fi"

[[rate_limiting]]
binding      = "BOOKING_RL"
namespace_id = "1"
simple       = { limit = 5, period = 60 }
```

### SPA (Vite build-time)

```text
VITE_WORKER_URL=https://booking-worker.pekka-nikander.workers.dev
```

Falls back to `http://localhost:8787` when unset.

---

## 10. Long-term Direction — informative

This spike is a step further toward the vision outlined in the previous spike's
§10. Where the previous spike used DPoP as a "session key binding" that
approximated capability-based access, this spike uses proper UCAN delegation
chains where rights are explicit, transferable, and composable.

The Worker remains a necessary intermediary for two reasons: it holds CalDAV
credentials, and it acts as the root certificate authority for the UCAN graph.
Both could in principle be removed:

- CalDAV credentials: if browsers could hold and present OAuth tokens with
  fine-grained scopes, the Worker's credential proxy role would shrink.
- UCAN root authority: if practitioners issued UCAN delegations directly (from
  their own DID), the Worker would be a relay rather than a root. This requires
  practitioners to have UCAN-capable tooling, which does not yet exist in
  standard calendar clients.

The PassKey / `did:webauthn` path (§7 in `SECURITY-ARCHITECTURE.md`) is the
clearest near-term route toward genuine client-held identity. When a browser
can sign UCAN tokens with a device-bound key verified by the relying party,
the architecture collapses toward: practitioner signs availability delegations,
clients hold booking capabilities, Worker mediates only CalDAV I/O.
