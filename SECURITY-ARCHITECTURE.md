# Booking Calendar — Security Architecture (UCAN)

> First version. Produced alongside `ARCHITECTURE.md` and `IMPLEMENTATION-PLAN.md`
> for the UCAN security spike.
> Revise as open questions are resolved and spike findings accumulate.

---

## 1. Motivation

The previous spike (archived at
`archive/spike-google-calendar-with-ad-hoc-security/`) implemented a layered
but ad-hoc security model: DPoP for session binding, a proof-of-work puzzle as
a "right to book", and an HMAC cancellation nonce as a "right to delete". Each
mechanism addressed one threat in isolation. There was no formal model of what
any principal was allowed to do, and no principled way to delegate or transfer
rights.

This spike replaces that collection of ad-hoc mechanisms with
**UCAN — User Controlled Authorization Network** — a capability-based
authorisation model built on signed delegation chains. Each right is an
explicit, verifiable, transferable token. Principals hold keys; they grant
capabilities to other principals by signing delegation tokens; they exercise
capabilities by signing invocation tokens that carry the delegation chain as
proof.

The goal is not to discard the security properties of the previous model, but
to express them more cleanly, composably, and with a path toward genuine
client-held authorisation.

---

## 2. UCAN Concepts (brief)

This section is a minimal reference. Readers unfamiliar with UCAN should
consult the UCAN 0.10 specification.

**Principal** — any entity that holds an asymmetric key pair. Identified by a
Decentralised Identifier (DID), typically `did:key:<encoded-public-key>`. In
this project all principals use P-256 (ECDSA) keys.

**Resource** — a URI naming the object a capability applies to.

**Ability** — a string naming what may be done to a resource (e.g.
`booking/create`, `booking/delete`). Ability hierarchies are ordered:
`booking/*` subsumes all `booking/` abilities.

**Capability** — the triple `(resource, ability, caveats)`. Caveats are
additional constraints (e.g. an expiry time tighter than the token's own
`exp`).

**Delegation token** — a signed JWT issued by principal A to principal B,
granting B a capability that A itself holds. A may not delegate more than it
has (attenuation). Fields: `iss` (A's DID), `aud` (B's DID), `att`
(attenuations — an array of capabilities), `exp` (expiry), `prf` (proofs —
the previous delegation chain).

**Invocation token** — a signed JWT by which principal B exercises a
capability. Fields: `iss` (B's DID), `aud` (the service DID), `att` (the
capability being invoked, matching what was delegated), `exp`, `prf` (the
delegation chain).

**Proof chain** — the ordered sequence of delegation tokens linking the root
authority to the invoking principal. Invocations carry the full chain; the
verifier walks it from root to leaf.

---

## 3. Principal Model

### 3.1 Worker (`did:key:W`)

The Cloudflare Worker holds a stable EC P-256 key pair stored as a Cloudflare
Secret. Its DID is the **root authority** for the booking domain. All
capability chains ultimately originate here. The Worker issues delegations to
SPA instances when serving the slot list, and to SPA instances when
acknowledging a successful booking.

The Worker speaks on behalf of practitioners, who remain outside the UCAN
graph in this version (§3.5).

### 3.2 SPA instance (`did:key:SPA-i`)

Each browser session generates a non-extractable EC P-256 key pair on first
Service Worker activation. The public key is encoded as a `did:key` DID. This
is the same session key used for DPoP in the previous spike; its role is
expanded: it now identifies the principal rather than merely binding a request.

SPA instances are ephemeral — a new tab, a new device, or a cleared browser
state produces a new `SPA-i`. The session key persists in IndexedDB for the
lifetime of the Service Worker registration.

### 3.3 Client (`did:key:C`) — optional

A device-bound P-256 key materialised through a PassKey (WebAuthn credential).
Unlike the SPA session key, a PassKey DID is stable across sessions on the
same device, and may be synchronised across devices by the platform (iCloud
Keychain, Google Password Manager, etc.).

The Client principal is the human customer's durable identity within the UCAN
graph. It bridges multiple ephemeral SPA instances: a booking created from
`SPA-1` on a laptop can be cancelled from `SPA-2` on a phone, provided both
have been delegated rights through the shared `C` anchor.

The Client principal is optional in this architecture. Clients without a
PassKey operate solely through their ephemeral SPA DID.

Open question:  How to previde the equivalence of Passkeys based Client DID 
with email based verification / token.  This may be infeasible, but should 
be investigated.  See §10.5.

### 3.4 Client group

A client group is not a distinct principal type. It is the set of SPA
instances and Client DIDs that share a common delegation ancestor. If a Client
DID exists, it is that ancestor. Without a Client DID, cross-device grouping
requires a separate "link devices" flow (out of scope for this spike) in which
the Worker issues a shared group delegation to multiple SPA DIDs.

### 3.5 Practitioners (outside the UCAN graph)

Practitioners create and manage OPEN availability events directly in their
CalDAV calendar using any CalDAV client. They do not participate in the UCAN
protocol. The Worker acts as their agent, issuing capabilities to clients on
their behalf. A future extension could introduce a practitioner DID and have
them sign capability grants directly; this is out of scope here.

---

## 4. Resource Model

**Open slot** — `slot:<domain>/<uid>`

One resource per OPEN availability window in the CalDAV calendar. The `<uid>`
is a stable identifier derived from the CalDAV VEVENT's `UID` property or from
a deterministic hash of the calendar URL and slot start time (open question —
see §10.3). The slot resource comes into conceptual existence when the Worker
reads an OPEN event from the calendar; it does not require the Worker to
persist anything beyond what CalDAV already holds.

The slot resources must logically persist over multiple worker sessions.
That is, whenever the worker reads the same CalDAV VEVENT's, it must represent
them the same open slot resources.

**Booking** — `booking:<domain>/<uid>`

One resource per confirmed booking. The `<uid>` is the UUID generated by the
Worker when the booking VEVENT is written to CalDAV. This resource is created
at booking time and ceases to exist when the booking is cancelled or deleted.

---

## 5. Capability Lattice

Five abilities cover the full domain:

| Ability | Resource type | Holder |
|---|---|---|
| `slot/open` | `slot:<domain>/*` | Worker only (root) |
| `slot/read` | `slot:<domain>/*` | Public — no capability required |
| `booking/create` | `slot:<domain>/<uid>` | Granted by Worker to SPA-i (and optionally to C) |
| `booking/read` | `booking:<domain>/<uid>` | Granted by Worker to SPA-i at booking time |
| `booking/delete` | `booking:<domain>/<uid>` | Granted by Worker to SPA-i at booking time |

`slot/read` is intentionally public. There is no secret in knowing which time
slots are available. Probably purely conceptual; may not need any implementation 
at the first spike.

`slot/open` is a root-only ability; it exists to name the practitioner's role
in a future version where practitioners are first-class principals. For now the
Worker exercises it implicitly by reading CalDAV.  Again, probably purely conceptual; 
may not need any implementation at the first spike.

`booking/create` is the central gated capability. The Worker issues it
transiently when responding to a slot list request, as a short-lived (e.g. 30 min)
delegation targeted at the requesting SPA's DID and scoped to a specific slot
resource. Without a valid delegation in the proof chain, a booking request is
rejected regardless of other attributes.

`booking/delete` is issued by the Worker to the creating SPA immediately after
a booking is written. This replaces the HMAC cancellation nonce of the
previous architecture. The delegation is stored in IndexedDB alongside the
booking UID.

---

## 6. Delegation Flows

### 6.1 Slot list with embedded booking/create delegations

```
SPA-i                          Worker (W)
  |                                |
  |  GET /v1/slots                 |
  |  X-UCAN-DID: did:key:SPA-i     |
  |------------------------------->|
  |                                |  read CalDAV OPEN events
  |                                |  compute available slots
  |                                |  for each available slot:
  |                                |    issue delegation:
  |                                |      iss=W, aud=SPA-i
  |                                |      att=[{with: slot:.../uid,
  |                                |             can: booking/create}]
  |                                |      exp=now+1800 (30 min)
  |<-------------------------------|
  |  slots[] + ucan_tokens[]       |
```

The SPA stores each `(slot, delegation_token)` pair. The tokens are
short-lived; if the user takes more than 30 minutes (or whatever TTL is
chosen), they must re-fetch.

### 6.2 Booking invocation

```
SPA-i                          Worker (W)
  |                                |
  |  POST /v1/bookings             |
  |  Body: { slot_start, attendee, |
  |    notes,                      |
  |    ucan: <invocation JWT>  }   |
  |   invocation:                  |
  |     iss=SPA-i, aud=W           |
  |     att=[{with: slot:.../uid,  |
  |            can: booking/create}]
  |     prf=[<delegation from 6.1>]|
  |     exp=now+60                 |
  |------------------------------->|
  |                                |  validate proof chain
  |                                |  check slot still available
  |                                |  write CalDAV VEVENT
  |                                |  issue delegation:
  |                                |    iss=W, aud=SPA-i
  |                                |    att=[{with: booking:.../uid,
  |                                |           can: booking/delete}]
  |                                |    exp=<booking date + grace>
  |<-------------------------------|
  |  { uid, start, end,            |
  |    ucan_delete: <token> }      |
```

The SPA stores `ucan_delete` in IndexedDB keyed by `uid`.

### 6.3 Booking cancellation invocation

```
SPA-i                          Worker (W)
  |                                |
  |  DELETE /v1/bookings/:uid      |
  |  Body: { ucan: <invocation> }  |
  |   invocation:                  |
  |     iss=SPA-i, aud=W           |
  |     att=[{with: booking:.../uid|
  |            can: booking/delete}]
  |     prf=[<delegation from 6.2>]|
  |     exp=now+60                 |
  |------------------------------->|
  |                                |  validate proof chain
  |                                |  delete CalDAV VEVENT
  |<-------------------------------|
  |  204 No Content                |
```

### 6.4 Cross-device cancellation via Client DID (optional)

If the user has registered a PassKey (establishing `did:key:C`), the SPA can
re-delegate `booking/delete` to the Client DID at booking time, creating a
longer-lived transferable capability:

```
Delegation chain:
  W ──────────► SPA-i ──────────► C
  booking/delete   booking/delete
  aud=SPA-i        aud=C

On a second device (SPA-j), after PassKey authentication:
  SPA-j presents a UCAN invocation with chain:
    prf=[W→SPA-i, SPA-i→C]
    iss=C (signed by PassKey-derived key — see §7)
```

This chain is valid as long as none of the delegations have expired and the
Worker can verify the chain from its own root delegation. The `C→SPA-j` hop
is unnecessary if the Client DID can sign UCAN tokens directly; see §7 for
the signing constraint.

---

## 7. PassKey / Human Client Integration

WebAuthn private keys are non-extractable and cannot sign arbitrary payloads
as UCAN JWTs (which require standard ECDSA over the JWT signing input). Two
approaches are viable:

### Option A — PassKey as identity verifier, session key as UCAN signer

1. On first "register" flow, the browser calls `navigator.credentials.create()`
   and obtains a WebAuthn credential. The credential's public key is expressed
   as a `did:key:C`.
2. The Worker stores the mapping `(credential_id → did:key:C)` in Cloudflare
   KV. This is the only piece of Worker state beyond CalDAV.
3. On a subsequent session (`SPA-j` on another device), the user performs a
   WebAuthn assertion (`navigator.credentials.get()`). The Worker verifies the
   assertion, looks up `did:key:C`, and issues a `booking/delete` delegation
   targeting `SPA-j` — effectively recognising the new session as belonging to
   the same client.

In this approach the UCAN chain is `W → SPA-i` and `W → SPA-j`, both
independently. The `C` DID is an identity anchor known only to the Worker; it
is not carried in the UCAN chain. The delegation is simpler but `C` is not a
genuine first-class UCAN principal.

**Advantages**: No library changes; standard WebAuthn; Worker state is minimal.  
**Disadvantage**: `C` is opaque — capabilities cannot be delegated through
`C` without going back to the Worker.

### Option B — PassKey as UCAN principal via `did:webauthn`

The `did:webauthn` method (draft; under active development by the W3C DID
community) defines how a WebAuthn credential can serve as a DID. An invocation
token signed under this DID would use the WebAuthn assertion as the signature
— specifically: the UCAN payload hash is supplied as the `challenge` in
`navigator.credentials.get()`, and the resulting `(authenticatorData ||
clientDataJSON)` concatenation is the signature.

The Worker would need to verify this non-standard signature rather than
standard ECDSA. There is no deployed `did:webauthn` library for Cloudflare
Workers as of the time of writing.

**Advantages**: `C` is a genuine UCAN principal; full delegation chains through
`C` are possible; architecture is coherent.  
**Disadvantage**: Non-standard verification; implementation effort is
significant; specification is not yet stable.

### Recommendation for spike

Implement Option A in Stage 6 (exploratory). Option B is the architecturally
correct end state but should be deferred until `did:webauthn` stabilises.

---

## 8. Anti-Abuse and Replay Prevention

### 8.1 Delegation issuance rate limiting

The Worker replaces the proof-of-work puzzle with **rate-limited delegation
issuance**. When responding to `GET /v1/slots`, the Worker issues
`booking/create` delegations per available slot. This issuance is gated by IP
rate limiting (Cloudflare built-in binding). An attacker who cannot obtain
delegations cannot post bookings.

Unlike the puzzle, the delegation approach does not impose a computational
burden on the legitimate user. The anti-abuse property comes from the fact that
a valid `booking/create` delegation can only be obtained through the Worker,
and the Worker controls issuance rate.

### 8.2 Invocation freshness

UCAN invocation tokens carry both `iat` (issued-at) and `exp` (expiry). The
Worker rejects invocations where `exp` has passed or where `iat` is more than
a configured window in the past (e.g., 60 seconds). This prevents replay of
captured invocations.

This is weaker than DPoP-Nonce replay prevention (no server-issued nonce means
no binding to a server-seen value), but acceptable at this threat level. An
open question (§10.6) discusses whether a server-issued nonce should be
reintroduced.

### 8.3 Delegation expiry

`booking/create` delegations are short-lived (suggested: 30 minutes TTL).
After expiry, re-fetching the slot list obtains fresh delegations. This bounds
the window in which a captured delegation could be replayed by a different SPA
instance.

`booking/delete` delegations are longer-lived — at minimum until the booking's
scheduled start time plus a grace period. Their expiry is a configuration
choice (§10.8).

---

## 9. Token Format Options

Three options exist, ordered by implementation complexity:

### Option 1 — UCAN 0.10 JWT (recommended for spike)

Well-specified. JWT-based. Uses `att` (attenuations), `prf` (proofs by CID),
`iss`/`aud` as DIDs, `exp`/`iat`. Tooling exists (`ucan` npm package). The
`prf` field in the specification references delegation tokens by CID (content
hash), but for a stateless Cloudflare Worker without IPFS, inline embedding
is more practical (see open question §10.2).

The Worker signs delegations with its P-256 key; the SPA signs invocations
with its session key. Both use ES256 (ECDSA P-256) — the same algorithm
already in use for DPoP.

### Option 2 — Lightweight UCAN-inspired JWT

Drop the UCAN 0.10 spec and use a minimal custom JWT format with the same
semantic fields (`iss`, `aud`, `att`, `prf`, `exp`). Avoids any dependency on
UCAN libraries; the verification logic is ~50 lines of TypeScript using
`jose`. Diverges from the standard, making future interoperability harder.

### Option 3 — UCAN 1.0 (ucanto)

Protocol Labs' production UCAN implementation used by web3.storage /
Storacha. Uses content-addressed CARs (Content Addressable aRchives) rather
than JWTs. Significantly more powerful but requires substantial infrastructure
(IPLD, multicodec, CAR parsing) that is non-trivial to run in a Cloudflare
Worker without bundling large dependencies.

### Recommendation

Start with Option 1 (UCAN 0.10 JWT with inline proof embedding). Option 2 is
acceptable if UCAN library compatibility proves problematic on Cloudflare
Workers. Option 3 is out of scope for this spike.

---

## 10. Open Questions

These questions are unresolved at the time of writing. They should be answered
as the spike progresses and recorded as decisions in this document.

### 10.1 DID encoding

`did:key` for P-256 requires multibase base58btc encoding of
`(multicodec-prefix-0x1200 || compressed-P256-public-key)` — a 35-byte
input. This is approximately 50 characters. Implementing the encoding from
scratch in a Cloudflare Worker using only Web Crypto is feasible but requires
a base58btc implementation. An alternative is `did:jwk`, which base64url-encodes
the public JWK — simpler, but a draft method with less tooling support.

**Question**: use `did:key` (standard, more tooling) or `did:jwk` (simpler
implementation)?

### 10.2 Proof chain representation

UCAN 0.10 references prior delegation tokens by their CID (content hash) in
the `prf` field, requiring the verifier to resolve the referenced token. For a
stateless Worker, this implies either (a) the client sends the full chain
inline in the request body alongside the invocation token, or (b) a small KV
store caches recently issued delegations by CID.

Inline embedding is simpler but diverges from the spec. CID-based resolution
with KV is spec-compliant but introduces Worker state and a lookup on every
request.

**Question**: embed proof chain inline (diverge from spec) or resolve by CID
(require KV)?

### 10.3 Slot resource UID

The `slot:<domain>/<uid>` URI requires a stable UID for each OPEN slot. Three
options:

- **CalDAV VEVENT UID**: stable as long as the OPEN event is not re-created;
  easy to extract; may be a long opaque string.
- **Hash of (calendar URL + slot start time)**: deterministic; survives OPEN
  event re-creation; requires hashing at read time.
- **Worker-assigned UUID**: clean but requires some persistence to maintain the
  OPEN-event-to-UUID mapping.

**Question**: which derivation scheme for slot UIDs?

### 10.4 PassKey integration approach

As discussed in §7: Option A (identity verifier + session key) or Option B
(`did:webauthn` as genuine UCAN principal)?

**Question**: pursue Option A in Stage 6, accept the architectural compromise,
and revisit Option B when the `did:webauthn` spec stabilises?

### 10.5 Cross-device grouping without PassKeys

For users without PassKeys, cross-device access to one's own bookings requires
either (a) the Worker to issue a "group delegation" to multiple SPA DIDs, (b)
a QR-code / link-based handoff of the `booking/delete` delegation token, e.g.
with email, or (c) simply accepting that cancellation is only possible from 
the originating session.

**Question**: is cross-device cancellation without PassKeys in scope for this
spike?

### 10.6 Replay prevention — server nonce vs. short TTL

The current design relies on short invocation `exp` and `iat` freshness
checking to prevent replay. This is weaker than the DPoP-Nonce scheme from the
previous spike (which bound each request to a server-seen nonce). An
alternative is to reintroduce a server-issued nonce — a `UCAN-Nonce` header on
responses, required as the `nnc` (nonce) field in invocations.

**Question**: is short-TTL freshness sufficient, or should a server nonce be
reintroduced?

### 10.7 Anti-abuse without proof-of-work

Delegation issuance rate limiting (§8.1) replaces the PoW puzzle. However,
the PoW puzzle also served as a barrier to scripted booking attempts that
already hold a valid delegation (e.g., a session that pre-fetched many
delegations before the rate limit window reset).

**Question**: is IP rate limiting on delegation issuance, combined with short
delegation TTL, a sufficient anti-abuse barrier? Or should some computational
friction be retained?

### 10.8 booking/delete delegation expiry

A `booking/delete` delegation that expires before the booking date is useless.
One that never expires is a liability (captured tokens remain valid
indefinitely). Options: (a) set expiry to booking start time + some grace
period; (b) set a fixed long TTL (e.g., 90 days); (c) use UCAN revocation.

**Question**: what is the appropriate expiry policy for `booking/delete`
delegations?

### 10.9 Worker DID key management

The Worker's DID private key is stored as a Cloudflare Secret. Rotating this
key invalidates all outstanding delegations (any booking/delete token held by
a client becomes unverifiable). The same trade-off existed with
`WORKER_NONCE_SECRET` in the previous spike.

**Question**: is key rotation an operational concern at this stage? If so, a
key version field in delegation tokens would allow the Worker to reject tokens
issued before the most recent key.

### 10.10 Delegation granularity

Issuing one `booking/create` delegation per available slot means the slot list
response grows linearly with the number of available slots. An alternative is
a single wildcard delegation `(slot:<domain>/*, booking/create)` with a caveat
constraining it to the current time window — the Worker would then verify the
requested slot falls within the caveat. This is more efficient but requires
caveat evaluation logic.

**Question**: per-slot delegations (simpler, more correct) or wildcard with
caveat (more compact)?
