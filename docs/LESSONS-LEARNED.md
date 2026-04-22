# Lessons Learned

Condensed findings from the spike stages. Intended to inform the production
implementation so we do not repeat the same mistakes.

---

## FullCalendar: `startStr` is local time, not UTC

`EventApi.startStr` and `endStr` return a locale-formatted string that includes
the browser's timezone offset — e.g. `"2026-04-22T13:00:00+03:00"` — not the
original UTC string used to create the event.

`EventApi.start` is a `Date` object. Use `.toISOString()` to recover the
canonical UTC string.

**Impact here:** the Worker's input validation rejected bookings outright with a
400 because `slot_start` did not match the `...Z` regex. The symptom was a
2 ms 400 response with no useful message in the UI.

**Rule for production:** any code that reads event times out of FullCalendar
must use `.start` / `.end` (Date objects) and call `.toISOString()`, never
`startStr` / `endStr`.

---

## Cloudflare `[[rate_limiting]]` binding is absent in `wrangler dev`

The `BOOKING_RL` binding declared in `[[rate_limiting]]` is `undefined` when
running locally under `wrangler dev`. Calling `env.BOOKING_RL.limit(...)` throws
`TypeError: Cannot read properties of undefined (reading 'limit')`.

**Fix:** declare the binding as optional (`BOOKING_RL?: RateLimit`) and guard
with `if (env.BOOKING_RL)`. Rate limiting is silently skipped in local dev,
which is acceptable for development.

**Rule for production:** any Cloudflare binding that is only available in the
deployed environment must be optional in the `Env` interface. Add a comment
noting the local-dev absence.

---

## Worker secrets are not validated at startup

Cloudflare Workers (module syntax) have no startup lifecycle hook. The `env`
object is only available inside request handler callbacks. A missing or
empty secret produces a cryptic error deep in whatever code first uses it
(e.g. WebCrypto throws `DataError: Imported HMAC key length (0)...`).

**Fix:** add a `checkEnv(env)` call at the top of the `fetch` handler that
validates all required fields and returns a `500` with a clear log message if
any are missing. This fires on the first request rather than at startup, but
it is far better than failing silently mid-operation.

**Rule for production:** always include a `checkEnv`-style guard. It is also
useful documentation of what the worker actually requires.

---

## `worker/.wrangler/` must be gitignored

Running `wrangler dev` creates a `.wrangler/` directory next to `wrangler.toml`
containing Miniflare's local simulation state (SQLite WAL files, cache state).
This is machine-local scratch and should never be committed.

**Fix:** add `worker/.wrangler/` to `.gitignore`. Wrangler's own init command
does not always do this automatically.

---

## Plan had a logical error in the PoW "window check" step

The implementation plan called for a cheap "pure arithmetic window check" as a
separate step before the HMAC check. In practice, the window ID is not stored
explicitly in the nonce — it is embedded as part of the HMAC pre-image. You
cannot determine whether the nonce was issued in a valid window without
computing the HMAC. The "arithmetic check" step was therefore a no-op and was
removed.

The HMAC verification (`verifyNonceHmac`) already handles both window validity
and authenticity in a single pass by trying the current and preceding window ID.

**Rule for production:** when designing stateless tokens, explicitly work out
what information is recoverable from the token alone versus what requires a key.
The ordering of checks should reflect actual computation dependencies, not a
hoped-for separation.

---

## ARCHITECTURE.md and IMPLEMENTATION-PLAN.md diverged on nonce-hash algorithm

An early draft of `ARCHITECTURE.md §3a` described storing a plain `SHA-256`
digest of the cancellation nonce as `X-BOOKING-HASH`. The implementation plan
(written later and more carefully) correctly specified `HMAC-SHA256` with a
server secret.

Plain SHA-256 is insufficient: a party with CalDAV read access could read
`X-BOOKING-HASH`, then brute-force or precompute the nonce needed to forge a
cancellation request (32 bytes is too large to brute-force, but the point is
the design offers no defence in depth). HMAC with a secret ensures that
knowing the hash tells an attacker nothing useful without the key.

**Rule for production:** when two documents describe the same mechanism, the
more recently written and more detailed one is authoritative. Update the older
document immediately rather than leaving the discrepancy.

---

## `SLOT_MINUTES` was initially set as a Worker secret

The original deployment docs listed `SLOT_MINUTES` as a value to upload via
`wrangler secret put`. It is not a credential — there is nothing sensitive about
the slot duration. It belongs in `wrangler.toml [vars]` where it is visible,
version-controlled, and changeable without touching the secrets vault.

**Rule for production:** use `[vars]` for operational configuration (durations,
limits, flags). Reserve secrets for credentials and cryptographic keys. The
distinction also matters for auditability: `wrangler secret list` only shows
names, not values, so putting non-sensitive config there makes it harder to
inspect the running configuration.

---

## `slot_start` rename required coordinated changes across four files

The field was originally named `start` in `BookRequest`. Renaming it to
`slot_start` (needed so the puzzle pre-image unambiguously names the field)
required simultaneous edits to `types.ts`, `api.ts`, `booking.ts`, and the
Worker's `index.ts`. None of the changes were large, but a rename that touches
the API contract, the frontend type, two call sites, and the server simultaneously
is a sign that the name should have been chosen correctly from the start.

**Rule for production:** choose field names in the domain API deliberately and
early. `slot_start` is clearer than `start` regardless of the PoW binding
requirement; use it from day one.

---

## `wrangler dev` cannot run without secrets present

If `WORKER_NONCE_SECRET` or `WORKER_PUZZLE_SECRET` are absent from `.dev.vars`,
the worker crashes with a `DataError` on the first request to `GET /v1/challenge`
or `POST /v1/bookings`. There is no graceful degradation.

The `checkEnv` guard added in Stage 4 turns this into a clear `500` with a
console log message, which is acceptable. But the root cause is that `.dev.vars`
must be populated with all required secrets before starting local dev.

**Rule for production:** document the `.dev.vars` template in the repo (without
values). A developer cloning the repo should be able to read `DEPLOYMENT_SETUP.md`
§4.2 and know exactly what to put in `.dev.vars`.
