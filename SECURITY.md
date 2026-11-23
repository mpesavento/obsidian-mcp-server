# Security model

This server gives an AI client read **and write** access to a personal Obsidian vault. Treat it as sensitive as the vault itself. This file covers what the HTTP transport protects against, how, and what it does not cover.

## Threat model

- **The public URL is not a secret.** A Tailscale Funnel, Cloudflare Tunnel or Cloud Run URL gets a TLS certificate, and every certificate is published in Certificate Transparency logs. Scanners watch those logs. Assume the URL is known to attackers from day one.
- **Anyone on the internet can reach the OAuth endpoints.** Claude's hosted apps (claude.ai web, mobile, Desktop, Cowork) connect from Anthropic's cloud, so the server must be public on port 443. Network location can't be the gate.
- **Single user.** There is one legitimate human, the vault owner. Every approval is theirs.

## Controls (HTTP transport)

| Control | What it does | Config |
|---|---|---|
| **Consent gate** | `/authorize` renders a page. An authorization code is issued only after the current 6-digit TOTP code (RFC 6238) from the owner's authenticator app is entered. Codes are single-use per 30 s step. 5 tries per request. A 15-minute lockout after 10 failures. | `CONSENT_TOTP_SECRET` (required) |
| **Fail closed** | The HTTP transport refuses to start without a consent secret, and the provider refuses `authorize()` without a gate. A misconfiguration means "down", never "open". | — |
| **Registration allowlist** | Dynamic Client Registration accepts only allowlisted redirect URIs, plus RFC 8252 loopback redirects for local clients (Claude Code, Cursor, VS Code). This blocks a client that would deliver codes to an attacker-controlled site, even if the owner were tricked into approving it. | `OAUTH_ALLOWED_REDIRECT_URIS`, `OAUTH_ALLOW_LOOPBACK` |
| **Client cap** | At most N registered clients. The oldest are evicted together with their tokens. | `OAUTH_MAX_CLIENTS` |
| **PKCE (S256)** | Required on every authorization-code exchange (enforced by the MCP SDK). | — |
| **Refresh-token rotation** | Each refresh consumes the old refresh token and issues a new one. | — |
| **Audience check (RFC 8707)** | Tokens bound to a different resource are rejected. | `SERVER_URL` |
| **Strict CORS** | Only allowlisted browser origins get CORS headers. The Origin is never reflected. Native clients and Anthropic's servers send no Origin and are unaffected. | `CORS_ALLOWED_ORIGINS` |
| **Request log** | One JSON line per request with time, method, path, status, client IP, TCP peer, Funnel flag, user agent, `client_id`, JSON-RPC method, tool names and a write flag. **Never logged:** tokens, codes, query strings, request bodies. | `REQUEST_LOG_PATH` |
| **Alerts** | Fired on: new client registrations and rejected ones; consent approvals, failed codes and lockouts; 20 or more 401s from one IP within 10 minutes. Sent via Telegram, or stderr when Telegram isn't configured. | `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` |
| **Static bearer token** | An optional side door for local clients (`AUTH_TOKEN`), compared in constant time. Anyone holding it has full access, so keep it out of shell history and rotate it if exposed. | `AUTH_TOKEN` |
| **Deny by default** | Every MCP route requires a bearer token. Unknown paths return 404. Only `/health`, `HEAD /`, the OAuth metadata routes and the OAuth endpoints are public. Tests assert this. | — |

### Client IPs behind Tailscale Funnel
tailscaled overwrites `X-Forwarded-For` with the real public client IP and marks Funnel traffic with `Tailscale-Funnel-Request: ?1`. That's why the app trusts exactly one proxy hop (`trust proxy 1`). A process on the same machine that calls the port directly bypasses tailscaled and can forge these headers, so the log also records the TCP peer.

IPs are a forensic signal, not an identity. The owner travels, so there is no IP allowlist for the owner.

## Setup

```bash
npm run build
node scripts/totp-setup.mjs qr.png    # prints CONSENT_TOTP_SECRET=...; writes a QR if qrencode is installed
# scan qr.png into an authenticator app, add the secret to .env, then delete qr.png
node scripts/totp-setup.mjs --check   # prints the current code, to compare with the app
```

### Rotating everything (suspected compromise)
1. Stop the service. The OAuth store is kept in memory and rewritten from it, so never edit it while the server runs.
2. Back up, then empty, the OAuth store (`~/.config/obsidian-mcp/oauth-store.json` or `OBSIDIAN_MCP_OAUTH_STORE`).
3. Generate a new `AUTH_TOKEN` and a new `CONSENT_TOTP_SECRET`, and re-scan the QR code.
4. Start the service and reconnect each client once.

## Known limitations / roadmap
- **DCR is still on** (allowlisted). The current MCP authorization spec deprecates DCR in favour of pre-registered clients or Client ID Metadata Documents. Planned: pre-register the claude.ai client (custom connector → "Use your own OAuth client") and Claude Code (`--client-id`, `--callback-port`), then turn DCR off.
- **Tokens are stored in clear** in the OAuth store (file mode 0600). Planned: store SHA-256 hashes.
- **One scope, `mcp:tools`**, so read and write can't be separated per client yet.
- **TOTP can be phished** in real time. Planned: passkeys (WebAuthn) as the primary factor.
- **The stdio transport has no auth.** It is local only and inherits the security of the machine.

## Tests
The tests use a temporary OAuth store and never touch the live one. The `tests/http.test.ts` suite covers:
- deny-by-default on every MCP route
- CORS not reflecting the Origin
- the registration allowlist
- the full consent → code → PKCE token → MCP flow
- TOTP replay, deny and lockout
- the request log containing no secrets

## Reporting
Open a GitHub security advisory on this repository (Security → Report a vulnerability) rather than a public issue.
