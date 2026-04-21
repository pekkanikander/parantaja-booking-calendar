# Booking Calendar — Implementation Plan (CalDAV)

> **For Claude Code.** This document is the living plan for the project.
> Revise it as you learn. All decisions made during spikes should be
> reflected back here before moving to the next stage.
>
> The Google Calendar REST API spike is archived at
> `archive/spike-google-calendar/`. This plan supersedes it.

---

## Context & Goals

Build a **customer-facing booking calendar** with the following properties:

- Owner (the operator) "paints" availability by creating events titled `OPEN`
  in a designated calendar using Calendar.app, iOS Calendar, or any CalDAV
  client. `OPEN` events may span longer than a single bookable slot.
- Customers visit a static SPA, see available slots, pick one, enter their
  name and an optional note, and confirm.
- On confirmation, a booking event is written back to the same calendar;
  the slot is marked consumed by the presence of a non-OPEN event.
- No traditional backend server or database. All persistence lives in a
  CalDAV calendar.
- Hosted on GitHub Pages at `https://<subdomain>.pnr.iki.fi`.
- Fully open source. Target audience: individuals and small organisations
  who want to self-host their infrastructure for ethical/sovereignty reasons.
  The calendar backend may be Nextcloud, Baïkal, Radicale, or Google Calendar
  (via its CalDAV endpoint).

### Audience note

Unlike the archived Google REST spike, this version is explicitly designed for
people moving *away* from closed platforms toward self-hosted infrastructure.
Google CalDAV is used for the spike because the credentials already exist and
it is operationally cheapest to validate the architecture; it is not the
long-term target.

### Out of scope (for now)

- Confirmation emails (will be added separately via Windmill or n8n).
- iCloud/CalDAV bridging via iCloud credentials (deferred; browser CORS
  posture of `caldav.icloud.com` makes it impractical without a server).
- Authentication of customers.
- Multiple concurrent booking durations (fixed slot duration for v1).
- Recurring OPEN events (deferred).

---

## Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| UI framework | **Vanilla TypeScript** + **FullCalendar v6** (MIT) | No framework build complexity; FullCalendar handles rendering; same as archived spike |
| Bundler | **Vite** | Fast, TypeScript-native, produces static assets for GitHub Pages |
| Calendar backend | **CalDAV** (spike: Google CalDAV; production: any CalDAV server) | Open standard; Nextcloud, Baïkal, Radicale, Google all speak it |
| Worker | **Cloudflare Worker** (TypeScript) | Free tier; holds credentials server-side; now exposes domain API rather than transparent proxy |
| iCal parsing | **ical.js** (Mozilla, LGPL) | Pure ES module, no Node built-ins, runs in CF Workers; battle-tested in Thunderbird |
| Hosting | **GitHub Pages** + custom subdomain | Static, free, fits the repo |
| Language | **TypeScript** throughout | Strict mode; no `any` |

### Key architectural shift from archived spike

The archived spike used a *transparent auth proxy*: the Worker added an
Authorization header and forwarded all Google Calendar REST calls verbatim.
The frontend spoke the Google REST API directly.

This plan uses a *domain API*: the Worker exposes three JSON endpoints
(`GET /v1/slots`, `POST /v1/bookings`, `DELETE /v1/bookings/:uid`) and speaks CalDAV
internally. The frontend speaks JSON and is calendar-backend-agnostic.

This shift is necessary because CalDAV is XML/WebDAV; generating and parsing
that from browser TypeScript is impractical without a large dependency.

---

## Stage Overview

```
Stage 1 — Research & Architecture   (Claude Code) — Done
Stage 2 — Local Spike               (Claude Code + operator config) — Done
Stage 3 — GitHub Pages Deploy       (Claude Code + operator config) — Done
Stage 4 — Production / Portability  (post-spike, plan refined then)
```

---

## Stage 1 — Research & Architecture — Done

Produced `ARCHITECTURE.md` (at repo root). Key decisions recorded there:

- Domain API surface for the Worker
- CalDAV wire format (REPORT, PUT, DELETE, VEVENT)
- iCal parsing via `ical.js`; generation hand-rolled
- Google CalDAV deviations documented
- Security analysis updated for domain API (narrower attack surface than
  transparent proxy)

---

## Stage 2 — Local Spike — Done

**Goal:** A running local prototype demonstrating the full booking flow
against a real CalDAV calendar (Google CalDAV using existing credentials).
Happy path only — no error handling beyond conflict rollback.

**Entry condition:** Operator has approved `ARCHITECTURE.md` and this
document.

### 2.1 Repo scaffold

```
booking-calendar/
├── IMPLEMENTATION-PLAN.md      (this file)
├── ARCHITECTURE.md
├── frontend/
│   ├── index.html
│   ├── src/
│   │   ├── config.ts           ← WORKER_URL
│   │   ├── types.ts            ← Slot, BookRequest, BookResponse
│   │   ├── api.ts              ← JSON wrappers over Worker domain API
│   │   ├── calendar.ts         ← FullCalendar init, slot rendering
│   │   ├── booking.ts          ← booking form + optimistic flow
│   │   └── main.ts             ← entry point
│   ├── vite.config.ts
│   └── package.json
├── worker/
│   ├── src/
│   │   ├── auth.ts             ← service account JWT → access token (Web Crypto)
│   │   ├── caldav.ts           ← CalDAV REPORT/PUT/DELETE + ical.js parsing
│   │   ├── slots.ts            ← slot computation logic
│   │   └── index.ts            ← v1 domain API router
│   ├── wrangler.toml
│   └── package.json
└── .github/
    └── workflows/
        └── deploy.yml          ← stubbed; wired in Stage 3
```

### 2.2 npm packages

**Frontend** (`cd frontend && npm install`):

```
@fullcalendar/core
@fullcalendar/timegrid
vite
typescript
```

**Worker** (`cd worker && npm install`):

```
wrangler
@cloudflare/workers-types
typescript
ical.js                   ← CalDAV response parsing
```

### 2.3 Google CalDAV setup (operator — one-time)

Full setup instructions are in `docs/GOOGLE_CALDAV_SETUP.md`. Summary:

1. **Enable the CalDAV API** in GCP Console (separate from the Calendar API;
   not enabled by default). Without this every CalDAV call returns 403.
2. Create `worker/.dev.vars` (gitignored). Two auth methods are supported;
   service account is preferred when available:

```
# Method 1 — service account (preferred)
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","client_email":"...","private_key":"..."}

# Method 2 — user OAuth refresh token (fallback if service account is rejected)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# Shared
CALDAV_CALENDAR_URL=https://apidata.googleusercontent.com/caldav/v2/{calId}/events/
SLOT_MINUTES=30
```

If `GOOGLE_SERVICE_ACCOUNT_JSON` is present the worker uses the JWT bearer
flow; otherwise it falls through to the refresh token flow. See
`docs/GOOGLE_CALDAV_SETUP.md` and `ARCHITECTURE.md §3` for detail.

### 2.4 Worker implementation

See `ARCHITECTURE.md` for the full API surface and CalDAV wire format.

Module responsibilities:

- `auth.ts` — dual-mode: service account JWT (Web Crypto) or OAuth refresh token; selected by which env vars are present
- `caldav.ts` — REPORT query builder, PUT/DELETE helpers, ical.js parsing
- `slots.ts` — slot computation (same algorithm as archived spike)
- `index.ts` — routes `GET /v1/slots`, `POST /v1/bookings`, `DELETE /v1/bookings/:uid`

### 2.5 Frontend implementation

- FullCalendar `timeGridWeek` view — unchanged from archived spike
- `api.ts` now calls Worker domain API JSON endpoints, not Google Calendar REST. The JSON should use Cal.com-like field names where feasible, but only as a thin naming convention; the underlying data model remains intentionally much simpler.
- Slot computation moves entirely into the Worker; frontend just renders
  whatever the Worker returns
- Booking form — unchanged

### 2.6 Local dev wiring

```bash
# Terminal 1
cd worker && npx wrangler dev --port 8787

# Terminal 2
cd frontend && npm run dev   # http://localhost:5173
```

Worker CORS allows `http://localhost:5173`. No Vite proxy needed.

### 2.7 Smoke test

1. `wrangler dev` and `vite dev` running.
2. Open `http://localhost:5173` — FullCalendar renders current week.
3. Green slots appear where operator has created `OPEN` events in Google Calendar.
4. Click a slot → form appears → enter attendee name/email and optional notes → click Book.
5. Slot disappears; confirmation shown.
6. Reload page — slot does not reappear.
7. Open Google Calendar — booking event visible with customer name.

**Checkpoint 2** — operator runs smoke test, signs off or raises issues.

---

## Stage 3 — GitHub Pages Deploy — Done

**Goal:** Live at `https://bookings.pnr.iki.fi`.

### What was done

- `.github/workflows/deploy.yml` — two-job workflow: `deploy-worker` (via
  `cloudflare/wrangler-action`) then `deploy-pages` (Vite build →
  `actions/deploy-pages`). `VITE_WORKER_URL` injected as a workflow env var
  at build time; no `.env.production` file needed.
- `frontend/public/CNAME` — `bookings.pnr.iki.fi`; Vite copies it into
  `dist/` verbatim, GitHub Pages picks it up automatically.
- `frontend/src/config.ts` — changed to
  `import.meta.env.VITE_WORKER_URL ?? "http://localhost:8787"`;
  `vite/client` added to `tsconfig.json` types to satisfy `tsc`.
- `worker/src/index.ts` — `https://bookings.pnr.iki.fi` added to
  `ALLOWED_ORIGINS`.
- Worker secrets uploaded to Cloudflare via `wrangler secret put` (piped
  from file to avoid terminal corruption of multi-line JSON).
- GitHub repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- DNS: `bookings CNAME pekkanikander.github.io` at registrar.

Operator setup details in `docs/DEPLOYMENT_SETUP.md`.

**Checkpoint 3** — live URL `https://bookings.pnr.iki.fi` confirmed. Stage 3 closed.

---

## Stage 4 — Production / Portability (rough sketch)

*Plan to be detailed after Stage 3, based on findings.*

- **Non-Google CalDAV support**: test against Nextcloud (primary target) and
  Baïkal. Document any server-specific deviations. Provide operator setup
  guides for each.
- **VAVAILABILITY study / future direction**: investigate whether RFC 7953
  `VAVAILABILITY` could replace or complement the current `SUMMARY=OPEN`
  convention for representing operator availability. Note that this would only
  standardise availability representation, not booking semantics, so the
  Worker domain API would still remain application-level.
- **OpenAPI description**: publish an `openapi.yaml` for the Worker domain
  API early, so the API is easy to understand, test, and integrate from the
  wider open source ecosystem.
- **Standard problem details for errors**: consider replacing the current
  ad-hoc JSON error envelopes with RFC 7807 / RFC 9457 Problem Details once
  the API surface stabilises.
- **Outbound webhooks**: add a minimal webhook mechanism for lifecycle events
  such as `booking.created`, `booking.cancelled`, and possibly
  `booking.conflict`, so the system composes easily with tools like Windmill,
  n8n, email senders, and other automation layers.
- **Thin booking-type abstraction**: consider a very small configured booking
  type object (for example title, duration, timezone, optional description)
  to make the API and UI more recognisable to developers familiar with systems
  like Cal.com, without importing their larger data model.
- **Nonce-based DELETE protection** — as described in `ARCHITECTURE.md §3a`,
  prevents arbitrary deletion of other users' bookings via the Worker API.
- **Rate limiting** on `POST /v1/bookings` to prevent slot-squatting.
- **Error handling and user-facing messages** beyond "sorry, slot taken".
- **Loading states** and skeleton UI.
- **Mobile-responsive layout**.
- **Confirmation emails** via Windmill (or n8n) webhook from the Worker after
  successful booking.
- **Accessibility audit.**
- **Durable Objects lock** for per-slot atomicity (if traffic warrants it).
- **Configurable slot duration** (currently fixed in Worker env var).
- README polish and operator documentation for each supported CalDAV backend.

Consider also the following:

- After backend-owned booking exists, integrate one automation sink:
  - Windmill webhook / HTTP route for confirmation emails and follow-up tasks.
  - or n8n webhook for confirmation emails and follow-up tasks.
- Keep native `n8n` community-node packaging as optional and only pursue it if
  there is a distribution goal beyond this repo.

---

## Constraints & Principles for Claude Code

1. **TypeScript strict mode** everywhere. No `any`, no `// @ts-ignore`.
2. **No framework beyond FullCalendar** on the frontend — vanilla TS + Vite.
3. **No database.** The CalDAV calendar is the sole persistence layer.
4. **No secrets in frontend code.** All credentials live in the Worker.
5. **Minimal dependencies.** `ical.js` is the only added dependency beyond
   what was in the archived spike. Every further addition needs a reason.
6. **Write to the CalDAV standard.** Document Google-specific deviations
   explicitly rather than coding around them silently.
7. **Use Cal.com-inspired JSON naming only.** Endpoint names and JSON field
   names may be made familiar to programmers who know Cal.com, but do not
   import Cal.com concepts that do not exist in this architecture.
8. **Revise this plan** when findings change the approach.
9. **Stop at each checkpoint** and wait for operator sign-off.
10. **Ask rather than guess** on decisions with non-trivial consequences.
