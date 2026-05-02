# Booking Calendar — Implementation Plan (UCAN Spike)

> **For Claude Code / Codex.** This document is the living plan for the project.
> Revise it as you learn. All decisions made during spikes should be
> reflected back here and in `ARCHITECTURE.md` before moving to the next stage.

---

## Context & Goals

Build a **customer-facing booking calendar** with the following properties:

- Practitioner "paints" availability by creating events titled `OPEN` in a
  designated CalDAV calendar using Calendar.app, iOS Calendar, or any
  CalDAV client. `OPEN` events may span longer than a single bookable slot.
- Customers visit a static SPA, see available slots, pick one, enter their
  name and an optional note, and confirm.
- On confirmation, a booking event is written back to the same calendar.
- No traditional backend server or database. All persistence lives in a
  CalDAV calendar.
- Hosted on GitHub Pages at `https://bookings.pnr.iki.fi`.
- Fully open source. Target audience: individuals and small organisations
  who want to self-host their infrastructure for ethical/sovereignty reasons.

This spike focuses on **validating a UCAN-based security architecture**.
The booking functionality is essentially unchanged from the archived
`archive/spike-google-calendar-with-ad-hoc-security/` spike. The goal is
to replace the ad-hoc security mechanisms (DPoP, PoW puzzle, HMAC nonce)
with a principled UCAN capability model and discover what works, what
doesn't, and what questions remain open.

The CalDAV backend remains Google CalDAV for the spike; credentials are
already in place.

### Out of scope (for this spike)

- Confirmation emails.
- Non-Google CalDAV backends (Nextcloud, Baïkal, Radicale) — deferred to
  a production portability stage.
- Authentication of practitioners within UCAN (they remain outside the UCAN
  graph).
- Multiple slot durations (fixed duration).
- Recurring OPEN events.
- PassKey / `did:webauthn` integration (Stage 6, exploratory).

---

## Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| UI framework | **Vanilla TypeScript** + **FullCalendar v6** (MIT) | Unchanged from previous spike |
| Bundler | **Vite** | Unchanged |
| Calendar backend | **CalDAV** (spike: Google CalDAV) | Unchanged |
| Worker | **Cloudflare Worker** (TypeScript) | Unchanged |
| iCal parsing | **ical.js** (Mozilla, LGPL) | Unchanged |
| Hosting | **GitHub Pages** + custom subdomain | Unchanged |
| Language | **TypeScript** throughout, strict mode | Unchanged |
| UCAN tokens | **UCAN 0.10 JWT**, ES256 (P-256), inline proofs | See `SECURITY-ARCHITECTURE.md §9` |
| UCAN verification | **`jose`** on Worker (`jwtVerify` + manual chain walk) | Already a Worker dependency |
| DID encoding | `did:key` with P-256 — see open question SA §10.1 | Standard; most tooling support |

No new npm dependencies are expected beyond what is already present. The
UCAN 0.10 JWT format can be produced and verified with `jose` and raw Web
Crypto without a dedicated UCAN library. If a UCAN library is introduced,
it must run in the Cloudflare Workers runtime without Node built-ins.

---

## Stage Overview

```
Stage 1 — Architecture                  Done (this document + ARCHITECTURE.md +
                                             SECURITY-ARCHITECTURE.md)
Stage 2 — Worker UCAN Foundation        Worker DID, signing key, delegation issuance stub
Stage 3 — SPA UCAN Principal            SPA DID from session key; delegations received and stored
Stage 4 — Booking Flow                  Full UCAN-gated booking: delegation issuance + invocation
Stage 5 — Cancellation Flow             booking/delete delegation issuance + invocation validation
Stage 6 — PassKey Client Identity       Exploratory; Option A or B from SA §7, or both in stages
Stage 7 — Cross-device / Client Group   Depends on Stage 6 findings
Stage 8 — Production / Portability      Post-spike: non-Google CalDAV, deploy pipeline, polish
```

Stages 2–5 form the core spike. Stages 6–7 are exploratory and may be
demoted to a separate spike. Stage 8 is post-spike.

---

## Stage 1 — Architecture — Done

Produced `ARCHITECTURE.md`, `SECURITY-ARCHITECTURE.md`, and this document.

Key decisions recorded:

- UCAN 0.10 JWT with inline proof chains as the token format.
- Worker holds root authority (`did:key:W`); all `booking/create` and
  `booking/delete` delegations originate here.
- SPA session P-256 key doubles as the UCAN session DID (`did:key:SPA-i`).
- `GET /v1/slots` returns per-slot `booking/create` delegation tokens.
- `POST /v1/bookings` requires a UCAN invocation; returns a `booking/delete`
  delegation.
- `DELETE /v1/bookings/:uid` requires a UCAN invocation.
- No proof-of-work puzzle; no DPoP; no HMAC cancellation nonce.
- Ten open questions recorded in `SECURITY-ARCHITECTURE.md §10`.

---

## Stage 2 — Worker UCAN Foundation

**Goal:** The Worker can generate/hold its DID, sign delegation tokens, and
verify invocation chains. No frontend changes yet. Verified by integration
tests or curl.

### 2.1 Worker DID key setup

Generate a P-256 key pair for the Worker (one-time operator task):

```bash
# Generate PKCS8 private key and uncompressed public key
openssl ecparam -name prime256v1 -genkey -noout -out worker_key.pem
openssl pkcs8 -topk8 -nocrypt -in worker_key.pem -outform DER | base64 | tr -d '\n'
# → WORKER_UCAN_PRIVATE_KEY

openssl ec -in worker_key.pem -pubout -outform DER | tail -c 65 | base64 | tr -d '\n'
# → WORKER_UCAN_PUBLIC_KEY
```

Store both as Worker secrets. Add `UCAN_WORKER_DOMAIN` to `wrangler.toml
[vars]`.

### 2.2 `worker/src/ucan.ts` — new module

Responsibilities:

- `workerDid()` → derives `did:key:W` from `WORKER_UCAN_PUBLIC_KEY` at
  startup. The derivation requires multibase base58btc encoding of
  `(multicodec-p256-pub-prefix || compressed-public-key)`. See open question
  SA §10.1 for `did:jwk` as an alternative if this proves awkward.
- `issueDelegation(aud: string, resource: string, ability: string, ttlSecs: number)` →
  signs and returns a UCAN 0.10 delegation JWT.
- `validateInvocation(token: string, expectedResource: string, expectedAbility: string)` →
  parses and verifies an invocation JWT and its embedded proof chain. Returns
  the `iss` DID on success; throws a typed error on any failure.

Validation steps: see `ARCHITECTURE.md §3.4`.

### 2.3 `worker/src/index.ts` — minimal changes

Remove DPoP validation block. Remove puzzle endpoint. Add CORS header for
`X-UCAN-DID`. No endpoint logic changes yet (booking endpoints remain
returning stubs or the existing logic with no auth gate).

### 2.4 Smoke test

```bash
# Confirm Worker starts with the new secrets
npx wrangler dev

# Call the (not yet gated) slot list
curl http://localhost:8787/v1/slots?start=...&end=...
```

**Checkpoint 2** — Worker starts without error; `workerDid()` returns a
well-formed DID; `issueDelegation` and `validateInvocation` pass unit tests
(written inline or in a separate test file).

---

## Stage 3 — SPA UCAN Principal

**Goal:** The SPA's Service Worker generates (or loads) a P-256 session key
and derives a `did:key:SPA-i`. This DID is included in all requests as
`X-UCAN-DID`. The SPA receives delegation tokens from the slot list response
and stores them in IndexedDB. No invocation signing yet.

### 3.1 `frontend/src/sw.ts` — DID derivation

Extend the existing session key generation to also compute `did:key:SPA-i`
and store it in IndexedDB alongside the key pair. Expose the DID as a
variable accessible to the main bundle (via a `postMessage` or by storing it
in a well-known IndexedDB key readable from both contexts).

Include `X-UCAN-DID: <did>` on all outgoing requests to the Worker origin.
Update CORS preflight: add `X-UCAN-DID` to `Access-Control-Allow-Headers`.

### 3.2 `frontend/src/api.ts` — delegation storage

Update `fetchSlots` to read `data.delegations` from the slot list response
and write each `(slot_uid, delegation_jwt)` pair to IndexedDB. The slot UID
key must match the scheme used by the Worker (see open question SA §10.3).

### 3.3 `worker/src/index.ts` — issue delegations on `GET /v1/slots`

After computing available slots, read the `X-UCAN-DID` header. If present
and well-formed, call `issueDelegation` for each available slot and include
the tokens in the response under `data.delegations`. If the header is absent
or malformed, return slots without delegations (graceful degradation until
Stage 4 wires up the full flow).

### 3.4 Rate limit delegation issuance

Apply the `BOOKING_RL` rate limit binding to `GET /v1/slots`. Tune the
threshold conservatively (same default as the previous spike: 5 per 60 s per
IP). This is the primary anti-abuse gate replacing the PoW puzzle.

**Checkpoint 3** — browser console shows a well-formed `did:key:SPA-i`; DevTools
shows IndexedDB populated with delegation tokens after a slot list fetch;
Worker logs confirm delegations were signed for the correct audience DID.

---

## Stage 4 — Booking Flow

**Goal:** The full `booking/create` UCAN invocation flow works end-to-end.
`POST /v1/bookings` requires and validates a UCAN invocation; the Worker
rejects requests without a valid chain.

### 4.1 `frontend/src/sw.ts` — invocation signing

Add `buildInvocation(resource: string, ability: string, proof: string): Promise<string>` —
signs a UCAN invocation JWT using the session private key. The function reads
the DID and private key from IndexedDB, sets `iss`, `aud` (Worker DID,
injected at build time as `__WORKER_DID__`), `att`, `prf`, `exp` (now+60),
`iat`.

### 4.2 `frontend/src/api.ts` — include invocation in POST

Update `postBooking` to:
1. Look up the delegation token for the target slot from IndexedDB.
2. Call `buildInvocation` to sign the invocation.
3. Include `"ucan": <invocation_jwt>` in the POST body.

Remove the `puzzle_nonce` and `puzzle_solution` fields from the request type.

### 4.3 `worker/src/index.ts` — gate POST on UCAN

In the `POST /v1/bookings` handler:

1. Extract `ucan` from the request body.
2. Call `validateInvocation(ucan, "slot:<domain>/<uid>", "booking/create")`.
3. On failure: return `401` (malformed/expired invocation) or `403` (chain
   verification failed), with Problem Details.
4. On success: proceed with slot availability check and CalDAV write.
5. Remove puzzle verification; remove `puzzle_nonce` and `puzzle_solution`
   from the input validation schema.

**Checkpoint 4** — end-to-end booking works; `POST /v1/bookings` without a
UCAN field returns `401`; a booking with a forged invocation (wrong key)
returns `403`; a booking with an expired delegation returns `401`.

---

## Stage 5 — Cancellation Flow

**Goal:** `DELETE /v1/bookings/:uid` is UCAN-gated. The Worker issues a
`booking/delete` delegation on booking creation; the SPA stores it and
presents it on cancellation.

### 5.1 `worker/src/index.ts` — issue booking/delete delegation

After a successful CalDAV PUT (and conflict check), call:

```typescript
issueDelegation(
  spaDid,                               // aud = requesting SPA
  `booking:${domain}/${uid}`,           // resource
  "booking/delete",                     // ability
  ttlSecs                               // from config: booking start + grace
)
```

Include the resulting token as `data.ucan_delete` in the `200` response.

Remove generation of `cancellation_nonce` and `X-BOOKING-HASH`.

### 5.2 `frontend/src/api.ts` — store delete delegation

Update `postBooking` to extract `data.ucan_delete` from the response and
write it to IndexedDB keyed by `uid`. Remove `cancellation_nonce` from
`localStorage`.

### 5.3 `frontend/src/api.ts` — send invocation on DELETE

Update `cancelBooking` to:
1. Load the `booking/delete` delegation from IndexedDB.
2. Call `buildInvocation` to sign a `booking/delete` invocation.
3. Send `DELETE /v1/bookings/:uid` with `{ "ucan": <invocation> }`.

### 5.4 `worker/src/index.ts` — gate DELETE on UCAN

In the `DELETE /v1/bookings/:uid` handler:

1. Extract `ucan` from the request body.
2. Call `validateInvocation(ucan, "booking:<domain>/<uid>", "booking/delete")`.
3. On failure: `401` or `403`.
4. On success: delete the CalDAV VEVENT.

Remove the existing HMAC nonce validation and `X-BOOKING-HASH` lookup.

### 5.5 CalDAV VEVENT cleanup

Remove `X-BOOKING-HASH` from the VEVENT generated in the PUT path. The
booking cancel is now governed by the UCAN delegation, not a stored hash.

**Checkpoint 5** — cancellation works end-to-end; `DELETE` without UCAN
returns `401`; `DELETE` with a `booking/delete` delegation for a different
UID returns `403`; a booking cancelled by the practitioner via CalDAV client
no longer returns `404` before a UCAN check (just `404` from CalDAV).

---

## Stage 6 — PassKey Client Identity (exploratory)

**Goal:** A customer with a PassKey can cancel a booking from a different
browser session than the one that created it. Implement Option A from
`SECURITY-ARCHITECTURE.md §7` (PassKey as identity verifier; session key as
UCAN signer).

This stage introduces the only piece of Worker-side mutable state in this
architecture: a Cloudflare KV namespace storing `(credential_id →
did:key:C)` mappings.

### Outline

1. **Registration flow** — new SPA page or modal: calls
   `navigator.credentials.create()`, sends the credential ID and attestation
   to a new `POST /v1/passkey/register` endpoint. Worker stores
   `(credential_id → did:key:SPA-i-at-registration-time)` in KV. The SPA's
   current session DID becomes the Client DID `C`.

2. **Login flow** — new `POST /v1/passkey/verify` endpoint: Worker issues a
   WebAuthn challenge, verifies the assertion, looks up `did:key:C` in KV,
   issues a fresh `booking/delete` delegation for any bookings associated with
   `C` that the Worker can find. (Finding them is an open question: the Worker
   would need to query CalDAV for recent bookings, or maintain a
   `booking_uid → C` index in KV.)

3. **Cross-device cancellation** — the new session (`SPA-j`) holds a freshly
   issued `booking/delete` delegation and can cancel normally.

### Open questions specific to Stage 6

- How does the Worker know which bookings to re-issue `booking/delete`
  delegations for? CalDAV VEVENT does not natively store the client DID.
  Options: (a) store `X-UCAN-AUD: did:key:C` as a custom VEVENT property;
  (b) maintain a KV index `(credential_id → [booking_uid, ...])`.
- Expiry of `(credential_id → did:key:C)` mappings: never? After N days of
  inactivity?

**Checkpoint 6** — a booking created in browser A can be cancelled from
browser B after PassKey verification, without the original session key.

---

## Stage 7 — Cross-device / Client Group

Depends on Stage 6 findings. If Option A proved sufficient (§7 in SA), Stage 7
may not be needed as a separate stage — it is subsumed by the PassKey flow.

If Option A revealed significant limitations (e.g., the KV-based identity
anchor is too opaque), Stage 7 would explore Option B (`did:webauthn` as a
genuine UCAN principal) or an alternative group delegation scheme.

Plan to be detailed after Stage 6.

---

## Stage 8 — Production / Portability (rough sketch)

*Plan to be detailed after the core spike (Stages 2–5) is complete.*

- **Non-Google CalDAV support**: Nextcloud (primary target), Baïkal, Radicale.
  Basic auth for Nextcloud app passwords (`Authorization: Basic`). Document
  any per-server deviations.
- **GitHub Actions deploy pipeline**: restore the `deploy.yml` workflow
  (worker deploy + Vite build → GitHub Pages). Inject `VITE_WORKER_URL` and
  `__WORKER_DID__` at build time.
- **OpenAPI description** for the Worker domain API.
- **Error handling and user-facing messages** beyond "slot taken".
- **Loading states** and skeleton UI.
- **Mobile-responsive layout**.
- **Confirmation emails** via Windmill or n8n webhook.
- **Accessibility audit**.
- **Durable Objects lock** for per-slot atomicity (if traffic warrants it).
- **Outbound webhooks** for `booking.created`, `booking.cancelled`.
- README and operator documentation.

---

## Constraints & Principles for Claude Code

1. **TypeScript strict mode** everywhere. No `any`, no `// @ts-ignore`.
2. **No framework beyond FullCalendar** on the frontend.
3. **No database.** CalDAV is the sole persistence layer (KV only in Stage 6
   for PassKey credential mapping).
4. **No secrets in frontend code.** All credentials and signing keys live in
   the Worker.
5. **Minimal dependencies.** No UCAN library unless it runs cleanly in
   Cloudflare Workers with no Node built-ins and adds clear value over
   `jose` + raw Web Crypto. Every addition needs a reason.
6. **Write to CalDAV standard.** Document Google-specific deviations
   explicitly.
7. **Revise all three documents** (`ARCHITECTURE.md`, `SECURITY-ARCHITECTURE.md`,
   `IMPLEMENTATION-PLAN.md`) when stage findings change any decision.
8. **Stop at each checkpoint** and wait for operator sign-off.
9. **Ask rather than guess** on open questions in `SECURITY-ARCHITECTURE.md §10`.
   Record decisions in that document as they are resolved.
