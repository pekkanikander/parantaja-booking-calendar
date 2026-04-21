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

These are the runtime environment variables for the deployed worker.
Run from `worker/` on your local machine (requires `wrangler login` first — see §4).

```sh
cd worker
npx wrangler secret put CALDAV_CALENDAR_URL
npx wrangler secret put SLOT_MINUTES
```

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

**OAuth refresh token:**
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
It is gitignored and never committed. Format:

```
CALDAV_CALENDAR_URL=https://apidata.googleusercontent.com/caldav/v2/...
SLOT_MINUTES=30
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

These values are only used by `wrangler dev`. The deployed worker uses the secrets
set in §3.3.

---

## 5. Ongoing operations

| Task | Command |
|------|---------|
| Deploy | Push to `main` — Actions handles everything |
| Tail live logs | `cd worker && npx wrangler tail` |
| Update a secret | `npx wrangler secret put <NAME>` |
| List secrets | `npx wrangler secret list` |
| Local dev | `cd worker && npm run dev` + `cd frontend && npm run dev` |
