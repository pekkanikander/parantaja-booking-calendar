# Booking Calendar — Project Context for Claude Code

## What this is

A customer-facing booking calendar, at the architecture spiking stage. 
Expect everything changing, sometimes behind your back.  Also consider
the implementation as eventually throw-away code, i.e. nothing needs to be
preserved and no backwards compatibility is needed, 
but keep still the code quality high.

Practitioners paint availability by creating `OPEN` events in a CalDAV calendar; 
customers book slots via a static SPA. No database — CalDAV is the sole persistence 
layer.

**Current spike**: replacing the previous ad-hoc security model with UCAN
(User Controlled Authorization Network). Booking functionality is unchanged;
the goal is to validate the UCAN security architecture.

## Key documents (read these first)

- `SECURITY-ARCHITECTURE.md` — principals, resources, capabilities, delegation
  flows, PassKey options, ten open questions. Start here for any security work.
- `ARCHITECTURE.md` — system architecture, data flows, Worker API surface,
  configuration. References `SECURITY-ARCHITECTURE.md` for the security model.
- `IMPLEMENTATION-PLAN.md` — stage-by-stage plan. Stage 1 is done. Implement
  Stage 2 next.

Previous spike is archived at
`archive/spike-google-calendar-with-ad-hoc-security/` — useful for reference
on CalDAV wiring, ical.js usage, and the slot computation algorithm, all of
which are carried forward unchanged.

## Stack

- **Frontend**: Vanilla TypeScript + FullCalendar v6, bundled with Vite,
  hosted on GitHub Pages (`https://bookings.pnr.iki.fi`).
- **Worker**: Cloudflare Worker (TypeScript), exposes `GET /v1/slots`,
  `POST /v1/bookings`, `DELETE /v1/bookings/:uid`.
- **Backend**: Google CalDAV (spike); target is any CalDAV server
  (Nextcloud, Baïkal, Radicale).
- **Security**: UCAN 0.10 JWT, ES256 (P-256), inline proof chains,
  verified with `jose` on the Worker side.

## Security model

See `SECURITY-ARCHITECTURE.md` whenever needed.

## Conventions

- TypeScript strict mode throughout; no `any`.
- No framework beyond FullCalendar on the frontend.
- No database; KV maybe in Stage 6 (PassKey credential mapping).
- No secrets in code or committed to git.
- Minimal dependencies — no UCAN library unless it runs cleanly in CF Workers
  with no Node built-ins and adds clear value over `jose` + raw Web Crypto.
- Revise all three documents when stage findings change any decision.
- Stop at each stage checkpoint and wait for operator sign-off.
- Open questions are in `SECURITY-ARCHITECTURE.md §10` — ask before resolving
  them unilaterally.
