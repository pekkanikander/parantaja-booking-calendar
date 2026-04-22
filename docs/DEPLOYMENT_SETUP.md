# Deployment Setup

One-time manual steps required to operate the live deployment.
Repeat these only when rotating credentials or moving to a new account.

---

## 1. DNS

At your registrar, add one record:

```
bookings   CNAME   pekkanikander.github.io.
```

GitHub Pages reads the `CNAME` file from the build artifact and enforces HTTPS automatically via Let's Encrypt. No further DNS configuration is needed.

---

## 2. GitHub repository

### 2.1 Enable GitHub Pages

Settings → Pages → **Source: GitHub Actions**

This must be set before the first deployment or the `deploy-pages` job will fail with a permissions error.

### 2.2 Add repository secrets

Settings → Secrets and variables → Actions → New repository secret

| Name | Value |
|------|-------|
| `CLOUDFLARE_API_TOKEN` | See §3.2 below |
| `CLOUDFLARE_ACCOUNT_ID` | See §3.1 below |

---

## 3. Cloudflare

### 3.1 Find your Account ID

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Click **Workers & Pages** in the left sidebar
3. Your **Account ID** appears in the right-hand sidebar — copy it

### 3.2 Create an API token

1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. **Create Token** → use the **"Edit Cloudflare Workers"** template
3. Under Account Resources, confirm your account is selected
4. **Continue to summary** → **Create Token**
5. Copy the token immediately — it is shown only once

### 3.3 Set worker secrets

These are runtime credentials and keys for the deployed worker.
Run from `worker/` on your local machine (requires `wrangler login` first — see §4.1).

```sh
cd worker
```

**Calendar URL** (contains your calendar ID — treated as a secret):

```sh
npx wrangler secret put CALDAV_CALENDAR_URL
# Paste: https://apidata.googleusercontent.com/caldav/v2/<calId>/events/
# where <calId> is your URL-encoded calendar ID (e.g. user%40gmail.com for user@gmail.com)
```

**Security secrets** (generate fresh random values for each deployment):

```sh
# Generate and upload in one step — never store these values anywhere
openssl rand -base64 32 | npx wrangler secret put WORKER_NONCE_SECRET
openssl rand -base64 32 | npx wrangler secret put WORKER_PUZZLE_SECRET
```

`WORKER_NONCE_SECRET` — used to HMAC-sign cancellation nonces stored in booking events.  
`WORKER_PUZZLE_SECRET` — used to HMAC-sign proof-of-work challenges issued to browsers.

Then whichever Google auth flow you use:

**Service account (recommended):**

Do **not** paste the service account JSON interactively — the terminal mangles
multi-line values. Pipe from the file instead:

```sh
# If you have the original .json file downloaded from Google Cloud Console:
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < ~/path/to/service-account-key.json

# If the only copy is in worker/.dev.vars, extract and pipe with Python
# (run from the repo root):
python3 -c "
import sys
for line in open('worker/.dev.vars'):
    if line.startswith('GOOGLE_SERVICE_ACCOUNT_JSON='):
        sys.stdout.write(line.split('=', 1)[1].strip())
" | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

**OAuth refresh token (fallback):**

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

The values are stored encrypted in Cloudflare's vault and injected into the worker at runtime.

To verify (values are never shown):

```sh
npx wrangler secret list
```

Secrets persist across deployments — they do not need to be re-set when code is pushed.

### 3.4 Non-secret configuration

The following values are set in `worker/wrangler.toml` under `[vars]` and are
visible in the repository. Edit the file and push to change them:

| Variable | Default | Meaning |
|----------|---------|---------|
| `SLOT_MINUTES` | `30` | Bookable slot duration in minutes |
| `PUZZLE_DIFFICULTY` | `10` | Leading zero bits required in the proof-of-work solution |
| `PUZZLE_WINDOW_SECONDS` | `30` | Duration of each PoW challenge time window; a challenge is accepted for the current window plus the preceding one (~60 s total validity) |

The rate limit for `POST /v1/bookings` (default: 5 requests per 60 seconds per IP) is
configured in the `[[rate_limiting]]` block in `wrangler.toml`. It is baked into the
binding at deploy time; edit and redeploy to change it.

---

## 4. Local development machine

### 4.1 Authenticate Wrangler

Required once per machine before running any `wrangler` commands against the live account:

```sh
cd worker
npx wrangler login
```

This opens a browser window to authorise Wrangler. The session token is saved to
`~/.wrangler/config/` and reused automatically.

### 4.2 Local credentials (.dev.vars)

The file `worker/.dev.vars` holds credentials for local development only.
It is gitignored and never committed. Create it with:

```
CALDAV_CALENDAR_URL=https://apidata.googleusercontent.com/caldav/v2/<calId>/events/
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

WORKER_NONCE_SECRET=<output of: openssl rand -base64 32>
WORKER_PUZZLE_SECRET=<output of: openssl rand -base64 32>
```

For local dev the security secrets can be any stable random string — they just need
to be present. The `SLOT_MINUTES`, `PUZZLE_DIFFICULTY`, and `PUZZLE_WINDOW_SECONDS`
variables are read from `wrangler.toml` by `wrangler dev` automatically; no need to
duplicate them in `.dev.vars`.

These values are only used by `wrangler dev`. The deployed worker uses the secrets
set in §3.3 and the vars set in §3.4.

---

## 5. Ongoing operations

| Task | Command |
|------|---------|
| Deploy | Push to `main` — Actions handles everything |
| Tail live logs | `cd worker && npx wrangler tail` |
| Update a secret | `cd worker && npx wrangler secret put <NAME>` |
| List secrets | `cd worker && npx wrangler secret list` |
| Rotate security secrets | Re-run the `openssl rand … \| wrangler secret put` commands from §3.3; existing bookings' cancellation nonces will be invalidated |
| Change slot duration / puzzle params | Edit `worker/wrangler.toml` `[vars]`, push to `main` |
| Change rate limit | Edit `worker/wrangler.toml` `[[rate_limiting]]`, push to `main` |
| Local dev | `cd worker && npx wrangler dev` + `cd frontend && npm run dev` |
