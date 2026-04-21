# Google CalDAV Setup

This document covers steps needed to connect the booking worker to Google Calendar via CalDAV.

This Spike (Spike 2) supports both [service accounts](#method-1-service-account-preferred) and [OAuth](#method-2-user-oauth-with-a-stored-refresh-token).

## Prerequisites (both methods)

### 1. Enable the CalDAV API

The CalDAV API is a separate GCP API and is **not** enabled by default, even if the Google Calendar API is already enabled.

1. Go to GCP Console → appropriate project (`booking-calendar-493618`)
2. APIs & Services → Library → search for **CalDAV API**
3. Click **Enable**

Or use the direct link (substituting your project number):
```
https://console.developers.google.com/apis/api/caldav.googleapis.com/overview?project=<PROJECT_NUMBER>
```

Wait a minute after enabling before testing.

### 2. CalDAV calendar URL

The `CALDAV_CALENDAR_URL` for a Google Calendar is:

```
https://apidata.googleusercontent.com/caldav/v2/<ENCODED_CALENDAR_ID>/events/
```

where the calendar ID has `@` percent-encoded as `%40`. For a calendar ID of
`abc123@group.calendar.google.com` the URL is:

```
https://apidata.googleusercontent.com/caldav/v2/abc123%40group.calendar.google.com/events/
```

The calendar ID is visible in Google Calendar → calendar settings → **Calendar ID**.

---

## Method 1: Service account (preferred)

A service account authenticates as its own identity using a self-signed JWT, with no human login required. This is the simplest long-term credential to manage.

**Limitation:** only tested against Google Workspace calendars or calendars explicitly shared with the service account on a project where the CalDAV API is enabled. For personal Google accounts the CalDAV API must be enabled in the same GCP project as the service account.

### Steps

1. **Create a service account** (skip if one already exists)
   - GCP Console → IAM & Admin → Service Accounts → **Create Service Account**
   - Note the email address (e.g. `worker@my-project.iam.gserviceaccount.com`)
   - Create and download a JSON key, to be added to `worker/.dev.vars`

2. **Share the calendar with the service account**
   - Open [calendar.google.com](https://calendar.google.com)
   - Calendar settings → **Share with specific people** → add the service account email
   - Set permission: **Make changes to events**

3. **Add to `worker/.dev.vars`**

```
GOOGLE_SERVICE_ACCOUNT_JSON=<contents of the downloaded JSON key, on a single line>
CALDAV_CALENDAR_URL=https://apidata.googleusercontent.com/caldav/v2/<encoded-calendar-id>/events/
SLOT_MINUTES=30
```

The JSON key file must be collapsed to a single line (it is already single-line when downloaded as a string value; do not add newlines).

---

## Method 2: User OAuth with a stored refresh token

This method authenticates as a real Google user account via OAuth 2.0. It requires a one-time interactive consent flow to produce a refresh token, which is then stored as a long-lived secret.

**When to use:** when the CalDAV endpoint rejects service account tokens (e.g. some personal Google accounts, or when domain-wide delegation is not configured).

### Steps

#### 2a. Create an OAuth consent screen

1. GCP Console → APIs & Services → **OAuth consent screen**
2. User type: **External**
3. Fill in app name, support email, developer contact
4. Scopes: add `https://www.googleapis.com/auth/calendar`
5. Test users: add the Google account that owns the calendar
6. Save (publishing is not required for local testing)

#### 2b. Create an OAuth 2.0 client

1. GCP Console → APIs & Services → Credentials → **Create Credentials** → **OAuth client ID**
2. Application type: **Web application**
3. Authorised redirect URIs: add `https://developers.google.com/oauthplayground`
4. Create → note the **Client ID** and **Client Secret**

#### 2c. Get a refresh token via OAuth Playground

1. Go to [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
2. Click the **gear icon** (top right) → tick **Use your own OAuth credentials** → enter your Client ID and Client Secret
   - This step is critical: if you skip it, the refresh token will be bound to Google's own playground credentials, not yours, and token exchange will return `unauthorized_client`
3. In the scope input (Step 1), enter `https://www.googleapis.com/auth/calendar` → click **Authorise APIs**
4. Sign in with the Google account that owns the calendar
   - If you see _"App has not completed Google verification / access_denied"_, go back to the consent screen and add your account under **Test users**
5. In Step 2, click **Exchange authorisation code for tokens**
6. Copy the `refresh_token` value from the JSON response

#### 2d. Add to `.dev.vars`

```
GOOGLE_CLIENT_ID=<your client id>
GOOGLE_CLIENT_SECRET=<your client secret>
GOOGLE_REFRESH_TOKEN=<refresh token from the playground>
CALDAV_CALENDAR_URL=https://apidata.googleusercontent.com/caldav/v2/<encoded-calendar-id>/events/
SLOT_MINUTES=30
```

---

## Using both methods together

The worker supports both methods simultaneously. If `GOOGLE_SERVICE_ACCOUNT_JSON` is present it is used; otherwise the three `GOOGLE_CLIENT_*` / `GOOGLE_REFRESH_TOKEN` variables are used. Including all five credential variables lets you fall back to user OAuth simply by removing (or commenting out) the `GOOGLE_SERVICE_ACCOUNT_JSON` line.

```
# Method 1 credentials (takes precedence when present)
GOOGLE_SERVICE_ACCOUNT_JSON=...

# Method 2 credentials (used if GOOGLE_SERVICE_ACCOUNT_JSON is absent)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# Shared
CALDAV_CALENDAR_URL=...
SLOT_MINUTES=30
```
