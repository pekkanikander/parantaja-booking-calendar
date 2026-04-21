# Booking Calendar — n8n / Windmill Research

Date: 2026-04-17

## Current shape

The current Stage 2 spike is not yet a good native component for either `n8n`
or `Windmill`.

- The Worker is only a Google Calendar auth+CORS proxy.
- Slot computation happens in the SPA.
- Booking creation, conflict check, and rollback also happen in the SPA.

That means the current backend surface is Google-API-shaped, not
booking-domain-shaped.

Before integrating with any automation platform, the first useful refactor is:

1. Move slot computation into server-side code.
2. Move booking creation + conflict handling into server-side code.
3. Expose a small domain API such as:
   - `GET /slots?from=...&to=...`
   - `POST /book`
   - `POST /cancel` or `DELETE /bookings/:id`
4. Emit a single authoritative `booking.created` event only after commit.

Without that step, any direct automation call from the browser is easy to spoof
and difficult to treat as the source of truth.

## n8n

Official docs confirm that `n8n` already has:

- a `Webhook` node for public HTTP entry points:
  https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
- a built-in `Google Calendar` node:
  https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlecalendar/
- a built-in `Google Calendar Trigger` node:
  https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.googlecalendartrigger/
- built-in email sending nodes:
  https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.sendemail/
  https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.gmail/

If a native custom integration is needed, `n8n` expects a community node npm
package built with `n8n-node`, with `nodes/` and `credentials/` directories:

- https://docs.n8n.io/integrations/creating-nodes/build/n8n-node/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/node-file-structure/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/credentials-files/

### Practical fit

`n8n` is a good fit for post-booking automation:

- send confirmation emails
- send owner notifications
- write CRM rows
- trigger follow-up workflows

`n8n` is a weaker fit for the booking core itself:

- public low-latency `GET /slots` and `POST /book` endpoints are possible with
  `Webhook` workflows, but awkward
- slot computation and booking conflict logic would likely end up split across
  `Webhook`, `Code`, and Google Calendar nodes
- the current vanilla SPA would still live outside `n8n`
- a custom `n8n` node would add packaging and maintenance work, but still
  would not replace the need for a public booking API

### Reasonable n8n integration path

Recommended path:

1. Keep the booking UI outside `n8n`.
2. Move booking authority into the Worker first.
3. After a successful booking, have the Worker call a private `n8n` webhook.
4. Let `n8n` handle email and downstream automation.

This gives the benefits of `n8n` without forcing the booking logic into a
workflow tool.

### What it would take to go more native in n8n

If you still wanted an `n8n` package, the smallest credible scope would be:

- one action node: `Booking Calendar`
- operations:
  - `List Slots`
  - `Create Booking`
  - `Cancel Booking`
- one credentials type for Google Calendar / booking API auth
- optional trigger node for `Booking Created`

That likely means extracting the booking logic into a reusable TypeScript
library first, then wrapping it for:

- Cloudflare Worker runtime
- `n8n` node runtime

## Windmill

Official docs confirm that `Windmill` has:

- webhooks for scripts and flows:
  https://www.windmill.dev/docs/core_concepts/webhooks
- custom HTTP routes:
  https://www.windmill.dev/docs/core_concepts/http_routing
- resources for credentials/config:
  https://www.windmill.dev/docs/core_concepts/resources_and_types
- Google Calendar integration stored as a resource:
  https://www.windmill.dev/docs/integrations/gcal
- SMTP integration stored as a resource:
  https://www.windmill.dev/docs/integrations/smtp
- full-code apps with React or Svelte plus backend runnables:
  https://www.windmill.dev/docs/full_code_apps

### Practical fit

`Windmill` is a better architectural fit than `n8n` if the goal is to host
part of the actual booking backend.

Reasons:

- custom HTTP routes are closer to a real API surface
- resources are a cleaner home for Google / SMTP credentials
- scripts/flows are easier to treat as application backend code
- webhook-specific tokens make it easier to expose narrow triggers safely

There are still tradeoffs:

- a full migration would likely mean replacing the Cloudflare Worker
- Windmill full-code apps are React/Svelte-based, while the current frontend is
  vanilla TypeScript
- if the public SPA remains on GitHub Pages, Windmill would most naturally be a
  backend/automation layer, not the frontend host

### Reasonable Windmill integration path

Most practical path:

1. Define the domain API first: `slots`, `book`, `cancel`.
2. Keep the current SPA, but let it call Windmill HTTP routes instead of a raw
   Google proxy.
3. Store Google Calendar and SMTP credentials as Windmill resources.
4. Run confirmation emails and other side effects in Windmill flows.

This is a plausible end-state if you want one platform for:

- booking API endpoints
- automation
- credentials
- operations UI / observability

### What it would take to go more native in Windmill

Smallest credible Windmill implementation:

- one script or module for slot listing
- one script or flow for booking
- one route per public endpoint
- one Google Calendar resource
- one SMTP resource
- one flow triggered after booking success for notifications

If later desired, the frontend could be rewritten as a Windmill full-code app,
but that is optional and would be a separate product decision.

## Recommendation

If the goal is simply "send confirmation emails and similar side effects":

- do not turn the current Worker directly into an `n8n` or `Windmill`
  component
- first make the Worker expose booking-domain endpoints
- then send a server-side webhook/event to an automation platform

Preferred order of exploration:

1. `Windmill` as downstream automation first, or as the future backend host if
   you want to consolidate more logic later.
2. `n8n` as downstream automation only.
3. Native `n8n` custom node only if there is a real distribution goal beyond
   this project.

## Concrete next step for this repo

Stage 4 should add a backend-owned booking surface and an event hook:

- `GET /slots`
- `POST /book`
- internal `emitBookingCreated(...)`

Then add one integration adapter:

- `POST` signed webhook to Windmill
- or `POST` signed webhook to n8n

Once that exists, confirmation emails become straightforward in either
ecosystem.
