# Google Calendar Setup

## Prerequisites

A personal Google account (@gmail.com) is sufficient. No Google Workspace subscription required.

---

## Step 1 — Create a GCP project

1. Go to https://console.cloud.google.com and sign in.
2. Click the project selector (top-left) → **New Project**.
3. Name it `booking-calendar` (or anything you like) → **Create**.

---

## Step 2 — Enable the Google Calendar API

1. In your new project, navigate to **APIs & Services → Library**.
2. Search for **Google Calendar API** → click it → **Enable**.

---

## Step 3 — Create a service account

1. Navigate to **APIs & Services → Credentials → Create Credentials → Service Account**.
2. Name: `booking-worker` (description optional).
3. Leave the role fields blank (calendar access is granted at the calendar level, not GCP level).
4. Click **Done**.

---

## Step 4 — Download the JSON key

1. In the Credentials list, click the service account you just created.
2. Go to the **Keys** tab → **Add Key → Create new key → JSON** → **Create**.
3. A JSON file is downloaded automatically. **Keep this file secret and do not commit it.**

The file looks like:

```json
{
  "type": "service_account",
  "project_id": "...",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "booking-worker@<project-id>.iam.gserviceaccount.com",
  ...
}
```

---

## Step 5 — Share your calendar with the service account

1. Open **Google Calendar** (calendar.google.com).
2. In the left sidebar, find the calendar you want to use for bookings.
   (Create a new one if needed: **Other calendars → +**.)
3. Click the three-dot menu next to it → **Settings and sharing**.
4. Under **Share with specific people or groups**, click **+ Add people**.
5. Enter the `client_email` from the JSON key file (e.g. `booking-worker@<project-id>.iam.gserviceaccount.com`).
6. Set permission to **Make changes to events**.
7. Click **Send**.

---

## Step 6 — Note your Calendar ID

1. On the same settings page, scroll to **Integrate calendar**.
2. Copy the **Calendar ID** (looks like `abc123xyz@group.calendar.google.com` for secondary calendars, or your email address for the primary calendar).

Important:

- The app reads exactly one calendar: the ID you put into `GOOGLE_CALENDAR_ID` and `frontend/src/config.ts`.
- `calendar.google.com` can show many calendars merged together in one UI. Seeing an `OPEN` event there does **not** prove that it exists in the one calendar the app is querying.
- If your Calendar ID ends with `@group.calendar.google.com`, it is a secondary calendar. When creating `OPEN` events in Google Calendar, Calendar.app, or iPhone Calendar, make sure the event is saved to that exact calendar, not to your default or primary calendar.

---

## Step 7 — Configure the local Worker

Create `worker/.dev.vars` (this file is gitignored — never commit it):

```
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","client_email":"booking-worker@...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",...}
GOOGLE_CALENDAR_ID=abc123xyz@group.calendar.google.com
```

Paste the full JSON from the downloaded key file as a single line (minified) as the value of `GOOGLE_SERVICE_ACCOUNT_JSON`. The literal `\n` sequences in the private key must remain as `\n` (not actual newlines), which they will be if you minify the JSON.

To minify the JSON, run:

```bash
cat your-key-file.json | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)))"
```

---

## Step 8 — Configure the frontend

Edit `frontend/src/config.ts` and replace the placeholder:

```typescript
export const CALENDAR_ID = "abc123xyz@group.calendar.google.com";
```

---

## Step 9 — Create test OPEN events

In Google Calendar, create a few events titled exactly **`OPEN`** on upcoming days (e.g. 09:00–11:00, 14:00–16:00). These will be sliced into bookable slots by the frontend.

Important:

- Create them in the exact calendar from Step 6.
- Prefer creating the first test events directly in `calendar.google.com`, with all unrelated calendars temporarily hidden, so you can clearly see which calendar owns the event.
- Use normal timed events, not all-day events.
- The title must be exactly `OPEN` in uppercase.

---

## Running locally

```bash
# Terminal 1 — Worker
cd worker
npm install
npx wrangler dev --port 8787

# Terminal 2 — Frontend
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Green slots should appear where you created OPEN events.

## Troubleshooting

If the SPA shows no green slots, check these first:

1. The `OPEN` events are in the wrong calendar.
   The app only queries the single calendar ID configured in `worker/.dev.vars` and `frontend/src/config.ts`. If you created `OPEN` in your primary calendar or another visible calendar, the SPA will show nothing.

2. The service account was not added to that same calendar.
   In **Settings and sharing → Share with specific people or groups**, verify that the service account email is listed there for the exact calendar from Step 6.

3. The permission level is too low.
   Use **Make changes to events**. Lower permissions may prevent the Worker from seeing enough event data to detect `OPEN` slots reliably.

4. The event is not a timed `OPEN` event.
   All-day events are ignored by the current Stage 2 implementation, and titles other than exact `OPEN` are treated as unavailable.
