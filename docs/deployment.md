# Deployment Guide

## Table of Contents

- [Local Setup (Claude Desktop & Code)](#local-setup)
- [Raspberry Pi + Tailscale Funnel](#raspberry-pi--tailscale-funnel)
- [Google Cloud Run](#google-cloud-run)
- [Security Considerations](#security-considerations)
- [Connecting Claude.ai](#connecting-claudeai)

---

## Local Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": ["/Users/mpesavento/src/obsidian-mcp-server/dist/index.js"],
      "env": {
        "VAULT_PATH": "/Users/mpesavento/Documents/Obsidian/ExoBrain"
      }
    }
  }
}
```

Restart Claude Desktop after saving. The server runs as a subprocess — no port needed.

### Claude Code (local)

```bash
claude mcp add obsidian-vault \
  -e VAULT_PATH=/Users/mpesavento/Documents/Obsidian/ExoBrain \
  -- node /Users/mpesavento/src/obsidian-mcp-server/dist/index.js
```

Verify:
```bash
claude mcp list
```

---

## Raspberry Pi + Tailscale Funnel

### Prerequisites

- Raspberry Pi running **64-bit OS** (verify: `uname -m` → `aarch64`)
- Tailscale installed and running (`tailscale status` shows connected)
- Obsidian vault synced to Pi (via Obsidian Sync, rsync, or Git)
- Node.js 22+ installed (recommend 24 LTS via [nvm](https://github.com/nvm-sh/nvm))

### Step 1: Install the server on the Pi

```bash
# Clone and build
git clone https://github.com/mpesavento/obsidian-mcp-server.git
cd obsidian-mcp-server
npm install
npm run build

# Configure
cp .env.example .env
```

Edit `.env`:
```bash
VAULT_PATH=/home/pi/ExoBrain
AUTH_TOKEN=<generate with: openssl rand -hex 32>
PORT=3100
AGENT_NAME_DEFAULT=claude
SERVER_URL=https://YOUR-PI-HOSTNAME.tail12345.ts.net
```

Replace `YOUR-PI-HOSTNAME.tail12345.ts.net` with your actual Tailscale hostname (find it with `tailscale status`).

### Step 2: Test locally on the Pi

```bash
node dist/index.js --transport http

# In another terminal:
curl http://localhost:3100/health
# → {"status":"ok","version":"0.1.0","transport":"http",...}
```

### Step 3: Enable Tailscale Funnel

Tailscale Funnel exposes a local port to the public internet with automatic TLS.

**One-time setup in Tailscale admin console** (https://login.tailscale.com/admin):

1. Enable **MagicDNS** (Settings → DNS)
2. Enable **HTTPS Certificates** (Settings → DNS → HTTPS Certificates)
3. Enable **Funnel** in ACL policy (Access Controls → Edit):
   ```json
   {
     "nodeAttrs": [
       {
         "target": ["autogroup:member"],
         "attr": ["funnel"]
       }
     ]
   }
   ```

**Start the funnel:**
```bash
sudo tailscale funnel --bg 3100
```

Verify:
```bash
sudo tailscale funnel status
# Should show:
# https://YOUR-PI-HOSTNAME.tail12345.ts.net (Funnel on)
# |-- / proxy http://127.0.0.1:3100

# Test from outside your network:
curl https://YOUR-PI-HOSTNAME.tail12345.ts.net/health
```

### Step 4: Create a systemd service

```bash
sudo tee /etc/systemd/system/obsidian-mcp.service > /dev/null << 'EOF'
[Unit]
Description=Obsidian MCP Server
After=network.target tailscaled.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/obsidian-mcp-server
EnvironmentFile=/home/pi/obsidian-mcp-server/.env
ExecStart=/usr/bin/node dist/index.js --transport http
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable obsidian-mcp
sudo systemctl start obsidian-mcp

# Check status
sudo systemctl status obsidian-mcp
sudo journalctl -u obsidian-mcp -f   # follow logs
```

> **Note:** If Node.js was installed via nvm, update `ExecStart` to use the full path:
> `ExecStart=/home/pi/.nvm/versions/node/v24.x.x/bin/node dist/index.js --transport http`

### Step 5: Connect Claude Code remotely

```bash
claude mcp add obsidian-vault \
  --transport http \
  https://YOUR-PI-HOSTNAME.tail12345.ts.net/ \
  --header "Authorization: Bearer YOUR_AUTH_TOKEN"
```

---

## Google Cloud Run

Cloud Run is a good alternative or fallback if the Pi is unreliable. The server is stateless (vault is the only persistent state, backed by Git), and Cloud Run provides automatic HTTPS, scaling, and ~$0/month for personal use.

### How it works

1. Docker image includes the MCP server
2. On container startup, the vault is cloned from your private GitHub repo
3. Server runs in HTTP mode with OAuth + bearer auth
4. Vault writes are periodically pushed back to Git

### Prerequisites

- Google Cloud project with billing enabled
- `gcloud` CLI installed and authenticated
- Private GitHub repo with your vault (as a Git backup)
- GitHub fine-grained PAT with `contents: read+write` on the vault repo

### Step 1: Create deployment files

The repo includes:
- `Dockerfile` — multi-stage build
- `.dockerignore` — excludes dev files
- `docker-entrypoint.sh` — clones vault at startup

### Step 2: Create secrets

```bash
# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com

# Generate and store auth token
AUTH_TOKEN=$(openssl rand -hex 32)
echo "AUTH_TOKEN: $AUTH_TOKEN"  # save this for Claude Code

echo -n "$AUTH_TOKEN" | gcloud secrets create AUTH_TOKEN --data-file=-
echo -n "ghp_YOUR_GITHUB_PAT" | gcloud secrets create GITHUB_TOKEN --data-file=-

# Grant Cloud Run service account access
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) \
  --format='value(projectNumber)')

for SECRET in AUTH_TOKEN GITHUB_TOKEN; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

### Step 3: Deploy

```bash
cd /path/to/obsidian-mcp-server

# Deploy from source (Cloud Build handles the Docker build)
gcloud run deploy obsidian-mcp \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --timeout 3600 \
  --cpu-boost \
  --max-instances 2 \
  --set-env-vars "VAULT_PATH=/vault,AGENT_NAME_DEFAULT=claude,VAULT_REPO=https://github.com/YOUR_USER/YOUR_VAULT_REPO.git" \
  --update-secrets "AUTH_TOKEN=AUTH_TOKEN:latest,GITHUB_TOKEN=GITHUB_TOKEN:latest"
```

> **Why `--allow-unauthenticated`?** The server handles its own auth via OAuth 2.1 and bearer tokens. Cloud Run's IAM auth would block Claude.ai from reaching the OAuth endpoints.

### Step 4: Set SERVER_URL

After deploy, Cloud Run outputs the service URL. Set it so OAuth metadata endpoints return the correct issuer:

```bash
SERVICE_URL=$(gcloud run services describe obsidian-mcp \
  --region us-central1 \
  --format='value(status.url)')

echo "Service URL: $SERVICE_URL"

gcloud run services update obsidian-mcp \
  --region us-central1 \
  --update-env-vars "SERVER_URL=$SERVICE_URL"
```

### Step 5: Verify

```bash
# Health check
curl "$SERVICE_URL/health"

# OAuth metadata
curl "$SERVICE_URL/.well-known/oauth-authorization-server" | python3 -m json.tool

# HEAD check (protocol version)
curl -I "$SERVICE_URL"
# Should include: MCP-Protocol-Version: 2025-06-18

# Test with Claude Code
claude mcp add obsidian-vault \
  --transport http \
  "$SERVICE_URL" \
  --header "Authorization: Bearer $AUTH_TOKEN"
```

### Cost

| Scenario | Estimated cost |
|----------|---------------|
| No `--min-instances` (cold starts OK) | **$0/month** (within free tier) |
| `--min-instances=1` (no cold starts) | **~$2-3/month** |

Based on ~10 requests/day. Cloud Run free tier includes 180K vCPU-seconds, 360K GiB-seconds, and 2M requests per month.

### Vault sync for writes

Writes modify the local Git clone inside the container. The entrypoint script includes a background sync loop that commits and pushes changes every 5 minutes:

```
write → local filesystem → git commit/push (every 5 min) → GitHub → Pi (via git pull or Obsidian Sync)
```

If the container is terminated between syncs, recent writes may be lost. For personal use with infrequent writes, this is acceptable. Set `--min-instances=1` to reduce the risk.

### Updating the deployment

```bash
# After code changes
gcloud run deploy obsidian-mcp \
  --source . \
  --region us-central1
```

---

## Security Considerations

### Authentication model

The server supports two auth mechanisms:

1. **OAuth 2.1 with DCR** — Required by Claude.ai. The server acts as both authorization server and resource server. Client registration, auth code exchange, and token refresh are handled automatically.

2. **Static bearer token** — For Claude Code remote access. Set via `AUTH_TOKEN` env var. Simpler, no browser redirect needed.

Both are accepted by the `DualTokenVerifier` — an incoming request with a valid OAuth token or a matching static bearer token is authenticated.

### Tailscale Funnel: understanding the exposure

Tailscale Funnel makes the server reachable at a public HTTPS URL (`https://your-hostname.ts.net`). This means:

**What's protected:**
- All MCP endpoints (`POST /`, `GET /`, `DELETE /`) require a valid bearer token
- TLS is handled by Tailscale — traffic is encrypted end-to-end
- The `.ts.net` hostname is not easily guessable (includes your tailnet name)

**What's exposed:**
- `GET /health` — returns server status (no vault data)
- `/.well-known/oauth-authorization-server` — OAuth metadata (public by design)
- `/.well-known/oauth-protected-resource` — resource metadata (public by design)
- `GET /authorize` — the OAuth authorization endpoint

### The auto-approve concern

The OAuth `authorize` endpoint auto-approves all requests (no consent screen). This means anyone who:
1. Discovers your Funnel URL
2. Sends a valid OAuth registration request
3. Follows the auth code flow

...could obtain a valid access token and access the vault.

**Mitigations in place:**
- The Tailscale hostname is obscure (not indexed, not guessable)
- The `redirect_uri` in the auth flow is validated against the registered client's redirect URIs
- OAuth tokens expire after 1 hour
- The vault contains personal notes, not credentials or financial data

**Optional hardening (if you want more protection):**

Add a passphrase gate to the `/authorize` endpoint. The user would need to know a passphrase (set in `.env`) to complete the OAuth flow. This is a one-time step per device — once Claude.ai has a token, it refreshes automatically.

To implement this, modify `src/auth/provider.ts`'s `authorize()` method to check for a `passphrase` query parameter or render a simple HTML form. This is documented as a future enhancement in the plan.

### Cloud Run security

- **`--allow-unauthenticated`** is required because Claude.ai must reach the OAuth endpoints without Google IAM credentials. The server's own auth layer handles access control.
- Secrets are stored in Google Secret Manager, not in env vars or code.
- The container runs as a non-root user (`USER node` in Dockerfile).
- The vault is cloned via a scoped GitHub PAT (single-repo, read+write only).

### Recommendations by deployment scenario

| Scenario | Auth | Additional hardening |
|----------|------|---------------------|
| Local only (Desktop/Code) | None needed (stdio) | — |
| Pi + Claude Code remote | Bearer token | Restrict Tailscale ACLs |
| Pi + Claude.ai | OAuth auto-approve | Consider passphrase gate |
| Cloud Run + Claude.ai | OAuth auto-approve | Service is public anyway; OAuth is sufficient |
| Cloud Run + Claude Code | Bearer token | Token in Secret Manager |

---

## Connecting Claude.ai

Claude.ai accesses remote MCP servers via **Connectors** (Settings → Connectors or Integrations).

### Via Tailscale Funnel (Pi)

1. Go to [claude.ai](https://claude.ai) → Settings → Integrations (or Connectors)
2. Click **Add Custom Integration**
3. Enter the URL: `https://YOUR-PI-HOSTNAME.tail12345.ts.net/`
4. Claude.ai will:
   - Discover the OAuth metadata at `/.well-known/oauth-authorization-server`
   - Register itself as a client via `/register`
   - Open a browser tab to `/authorize` (which auto-approves and redirects back)
   - Exchange the auth code for a token at `/token`
5. Once connected, the vault tools appear in Claude.ai's tool list

### Via Cloud Run

Same steps, but use the Cloud Run URL:
`https://obsidian-mcp-HASH-us-central1.a.run.app/`

### Troubleshooting

**"Connection failed" or timeout:**
- Verify the server is running: `curl https://your-url/health`
- Check OAuth metadata: `curl https://your-url/.well-known/oauth-authorization-server`
- Verify HEAD endpoint: `curl -I https://your-url/` (should include `MCP-Protocol-Version` header)

**"Invalid session" errors:**
- The server uses stateful sessions. If the server restarted, existing sessions are lost.
- Claude.ai should automatically re-initialize. If not, remove and re-add the integration.

**OAuth re-auth after server restart:**
- OAuth tokens are stored in memory. A server restart invalidates all tokens.
- Claude.ai will automatically re-authenticate via the refresh token or a new auth flow.
- This is seamless due to auto-approve — no user interaction needed.
