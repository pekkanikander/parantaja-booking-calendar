# Booking Calendar — Implementation Plan

> **For Claude Code.** This document is the living plan for the project.
> Revise it as you learn. All decisions made during spikes should be
> reflected back here before moving to the next stage.
> Feel free to create and update CLAUDE.md as we proceed.

---

## Context & Goals

Build a **customer-facing booking calendar** with the following properties:

- Owner (the operator) "paints" availability by creating events (e.g. titled
  `OPEN`) in a designated Google Calendar using Calendar.app or iOS Calendar.
  The `OPEN` events may be longer than the events booked by the customers.
- Customers visit a static SPA page, see available slots, pick one, enter their
  name/note, and confirm.
- On confirmation, a booking event is written back to the same (or a second)
  Google Calendar, and the part of `OPEN` slot is marked consumed (modified)
  or otherwise noted as consumed (e.g. noticing the two events at the same time.)
- No traditional backend server or database. All persistence lives in Google
  Calendar.
- Hosted on GitHub Pages at `https://<subdomain>.pnr.iki.fi`.
- Fully open source. Code quality must be high.

### Out of scope (for now)

- Confirmation emails (will be added separately via Windmill).
- iCloud/CalDAV integration (deferred; Google Calendar chosen for CORS
  compatibility).
- Authentication of customers.
- Multiple concurrent booking types / durations (fixed slot duration for v1).

---

## Technology Choices (provisional — spike may revise)

| Concern | Choice | Rationale |
|---|---|---|
| UI framework | **Vanilla TypeScript** + **FullCalendar v6** (standard, MIT) | Strongly typed; no framework build complexity; FullCalendar handles calendar rendering |
| Bundler | **Vite** | Fast, TypeScript-native, produces static assets suitable for GitHub Pages |
| Calendar API proxy | **Cloudflare Worker** (TypeScript) | Free tier; holds OAuth refresh token; ~80 LOC; no server to maintain |
| Calendar backend | latest **Google Calendar API** | CORS-friendly via Worker; write access; well-documented |
| Hosting | **GitHub Pages** + custom subdomain `<subdomain>.pnr.iki.fi` | Static, free, fits the repo |
| Language | **TypeScript** throughout (frontend + worker) | Strongly typed; compatible with Vite and Cloudflare Workers |

---

## Reference Material for Claude Code

Study these before writing any code:

1. **FullCalendar standard docs & Google Calendar plugin**
   - https://fullcalendar.io/docs
   - https://fullcalendar.io/docs/google-calendar (read-only iCal feed — note
     this is *not* what we use; we use the REST API via the Worker)
   - https://fullcalendar.io/docs/timeGrid-view (the view we likely want)
   - https://fullcalendar.io/docs/dateClick and
     https://fullcalendar.io/docs/eventClick (interaction callbacks)

2. **Cloudflare Worker with Google Calendar OAuth2**
   - https://github.com/cotter-code/calendar-booker — stale but the Worker
     pattern (src/worker or similar) is useful reference for OAuth token
     refresh against Google Calendar API
   - https://github.com/dennisklappe/CloudMeet — study
     `src/app/api/` for how it structures OAuth credential storage in
     Cloudflare KV and refresh-token handling. Do not copy the availability
     logic.
   - Cloudflare Workers docs: https://developers.cloudflare.com/workers/

3. **Google Calendar API** (v3 or newer)
   - Events: list, insert, delete/patch:
     https://developers.google.com/calendar/api/v3/reference/events
   - OAuth2 for server-side apps (refresh token flow):
     https://developers.google.com/identity/protocols/oauth2/web-server

4. **Vite static site + GitHub Pages**
   - https://vitejs.dev/guide/static-deploy.html#github-pages

---

## Stage Overview

```
Stage 1 — Research & Architecture   (Claude Code, output: revised PLAN.md)
Stage 2 — Local Spike               (Claude Code, output: runnable localhost)
Stage 3 — GitHub Pages Deploy       (Claude Code + operator config steps)
Stage 4 — Full Integration          (post-spike, plan refined then)
```

The plan below is detailed for Stages 1–3. Stage 4 is intentionally sketchy
until spike results are known.

---

## Stage 1 — Research & Architecture Plan — Done

**Goal:** Produce a concrete architecture document and a spike plan, ready
for operator review before any code is written.

**Claude Code tasks:**

### 1.1 Study reference repos

- Clone or fetch (read-only) the reference repos listed above.
- From CloudMeet: understand how the Cloudflare Worker stores and refreshes
  a Google OAuth2 refresh token using Cloudflare KV. Extract the minimal
  pattern.
- From cotter-code/calendar-booker: understand how the Worker proxies
  Google Calendar API calls from the static frontend.
- From FullCalendar examples: find the simplest `timeGridWeek` + `dateClick`
  demo that renders events from a JavaScript array.

### 1.2 Clarify the data model

Document answers to the following in `ARCHITECTURE.md`:

- What does an `OPEN` slot event look like in Google Calendar? (title
  convention, description, colour, duration encoding)
- What does a `BOOKED` event look like? (what fields does the Worker write)
- How does the frontend distinguish `OPEN` vs `BOOKED` vs other events when
  reading the calendar?
  - Assume no other than `OPEN` vs `BOOKED` events, e.g. any events
    that do not match the `OPEN` definition are by default understood as `BOOKED`.
- What is the minimal Google Calendar API scope required? (`calendar.events`
  read+write on a single calendar is sufficient — avoid full calendar access)
- How does the Worker authenticate? (service account vs OAuth2 refresh token
  — evaluate both; service account is simpler for a single-owner calendar)
  - document clearly any steps needed by the operator
- Does the Worker need any state beyond the credential? (No, if using a
  service account; yes if using a user OAuth2 token)

### 1.3 Identify CORS constraints

- Confirm that `caldav.icloud.com` blocks browser-origin CORS requests
  (confirming prior research, no need to retry).
- Confirm that Google Calendar REST API requires the Worker proxy (cannot
  call it directly from a GitHub Pages origin with write access without
  exposing credentials).
- Document the exact CORS headers the Worker must emit.

### 1.4 Produce `ARCHITECTURE.md`

Sections to include:

1. Component diagram (text/ASCII is fine)
2. Data flow: owner paints slot → customer sees slot → customer books →
   calendar updated
3. Google Calendar credential approach chosen (with rationale)
4. Worker API surface (the 2–3 endpoints it exposes)
5. Frontend state machine (idle → loading slots → slot selected → form →
   confirming → confirmed/error)
6. Concurrency / double-booking strategy (optimistic: Worker reads slot,
   writes booking; "oops" error surfaced to customer if slot already reserved)
7. Configuration surface (what goes in Worker env vars, what goes in
   frontend config)

### 1.5 Produce `SPIKE_PLAN.md`

A step-by-step checklist for Stage 2. Should include:

- Exact repo structure to create
- Which npm packages to install (FullCalendar packages, Vite, wrangler)
- Which Google Cloud project settings to configure (scopes, OAuth consent,
  credential type)
- Which Cloudflare account settings to configure (KV namespace if needed)
- Each Worker endpoint to implement, with input/output types
- Each frontend component to implement, with its TypeScript interface
- Local dev instructions (how to run Worker locally with `wrangler dev`,
  how to run Vite dev server, how to wire them together via a proxy)

**Checkpoint 1 — Operator review**

Claude Code stops and presents:
- `ARCHITECTURE.md`
- `SPIKE_PLAN.md`
- Any blocking questions or findings that change the approach

Operator reviews, amends if needed, then explicitly says "proceed to Stage 2".

---

## Stage 2 — Local Spike — Done

**Goal:** A running local prototype that demonstrates the full booking flow
end-to-end against a real Google Calendar. Not production quality — no
error handling beyond the happy path — but fully functional.

**Entry condition:** Operator has approved `ARCHITECTURE.md` and
`SPIKE_PLAN.md`.

**Claude Code tasks:**

### 2.1 Scaffold the repo

```
booking-calendar/
├── PLAN.md                  (this file)
├── ARCHITECTURE.md
├── SPIKE_PLAN.md
├── README.md
├── frontend/
│   ├── index.html
│   ├── src/
│   │   ├── main.ts
│   │   ├── calendar.ts      (FullCalendar init and slot rendering)
│   │   ├── booking.ts       (booking form logic)
│   │   ├── api.ts           (typed Worker client)
│   │   └── types.ts         (shared TypeScript interfaces)
│   ├── vite.config.ts
│   └── package.json
├── worker/
│   ├── src/
│   │   └── index.ts         (Cloudflare Worker)
│   ├── wrangler.toml
│   └── package.json
└── .github/
    └── workflows/
        └── deploy.yml       (GitHub Pages deploy — stubbed, wired in Stage 3)
```

### 2.2 Worker implementation

See `SPIKE_PLAN.md`

### 2.3 Frontend implementation

- FullCalendar `timeGridWeek` view.
- Fetch `/slots` on calendar navigation (date range change callback).
- Render `OPEN` slots as clickable events in a distinct colour.
- On slot click: show a minimal inline form (name field, optional note,
  confirm button).
- On confirm: create event, show success or "slot already taken" error.
- On success: remove the slot from the calendar view and show confirmation.
- TypeScript strict mode throughout. No `any`.

### 2.4 Local dev wiring

- `wrangler dev` runs the Worker on `http://localhost:8787`.
- Vite dev server proxies `/slots` and `/book` to `localhost:8787`
  (configure in `vite.config.ts` server.proxy).
- Document the exact `wrangler.toml` local secret setup for the Google
  credential.

### 2.5 Google Calendar setup instructions

Produce `docs/GOOGLE_SETUP.md`:

- Create a Google Cloud project.
- Enable Google Calendar API.
- Create a service account (preferred) or OAuth2 client (fallback).
- Share the target calendar with the service account email.
- Download credentials; document where to put them for local dev.

**Checkpoint 2 — Operator demo**

Claude Code stops. Operator:

1. Follows `docs/GOOGLE_SETUP.md` to provision credentials.
2. Creates a few `OPEN` events in the designated Google Calendar.
3. Runs `wrangler dev` and `vite dev` locally.
4. Confirms the full booking flow works in a browser.
5. Signs off or raises issues.

---

## Stage 3 — GitHub Pages Deploy

**Goal:** The spike is live at `https://<subdomain>.pnr.iki.fi`.

**Entry condition:** Checkpoint 2 signed off.

**Claude Code tasks:**

### 3.1 GitHub Actions workflow

- Vite build → `frontend/dist/` → deploy to `gh-pages` branch via
  `peaceiris/actions-gh-pages` or the native GitHub Pages action.
- Worker deploy via `cloudflare/wrangler-action`.
- Secrets needed in the repo: `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`, `GOOGLE_CREDENTIALS_JSON` (or equivalent).
- Document each secret in `docs/DEPLOY.md`.

### 3.2 Custom domain

- GitHub Pages custom domain: `CNAME` file in `frontend/` pointing to
  `<subdomain>.pnr.iki.fi`.
- Operator must add a DNS CNAME record at their registrar/DNS provider:
  `<subdomain>.pnr.iki.fi` → `<github-username>.github.io`.
- Document in `docs/DEPLOY.md`.

### 3.3 Worker CORS update

- Update Worker `Access-Control-Allow-Origin` from `http://localhost:*` to
  `https://<subdomain>.pnr.iki.fi`.
- Keep localhost allowed for dev.

### 3.4 Smoke test

- Hit `/health` endpoint.
- Verify slot fetch works from the live domain.
- Book a test slot end-to-end.

**Checkpoint 3 — Live site**

Operator confirms the live URL works. This closes Stage 3.

---

## Stage 4 — Production Hardening (rough sketch)

*This stage will be planned in detail after Stage 3, based on findings.*

Likely items:

- Error handling and user-facing error messages (beyond "oops, try again").
- Loading states and skeleton UI.
- Mobile-responsive layout.
- Configurable slot duration (dropdown for future multiple durations).
- Rate limiting on the Worker (prevent booking spam).
- Windmill webhook integration for confirmation emails.
- iCloud/CalDAV bridge (optional, if needed — likely a second Worker or
  a periodic sync script).
- Accessibility audit.
- README polish and operator documentation.

---

## Constraints & Principles for Claude Code

1. **TypeScript strict mode** everywhere. No `any`, no `// @ts-ignore`.
2. **No framework beyond FullCalendar** on the frontend — vanilla TS + Vite.
   Do not introduce React, Vue, or similar without operator approval.
3. **No database.** Google Calendar is the sole persistence layer.
4. **No secrets in frontend code.** All credentials live in the Worker's
   environment.
5. **Minimal dependencies.** Prefer the standard library and platform APIs.
   Every added npm package needs a reason.
6. **Revise this plan** (`PLAN.md`) when findings during a stage change the
   approach. Do not silently diverge.
7. **Stop at each checkpoint** and wait for operator sign-off before
   proceeding to the next stage.
8. **Ask rather than guess** when a decision has non-trivial consequences
   (e.g. credential approach, data model for OPEN vs BOOKED events).
