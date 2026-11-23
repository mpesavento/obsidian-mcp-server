import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { verifyTotp } from "./totp.js";
import type { Notifier } from "../audit/alert.js";

/**
 * Human consent for /authorize. No authorization code is issued until the
 * person at the browser types the current TOTP code from Mike's authenticator.
 * This replaces the old auto-approve, which let any internet client mint a
 * vault token.
 *
 * Defenses:
 *  - pending requests are random 256-bit ids and expire after 5 minutes
 *  - at most 5 attempts per pending request
 *  - after 10 failures in 15 minutes the gate locks for 15 minutes (and alerts)
 *  - a TOTP counter can be used only once (no replay inside the 30 s window)
 */

interface Pending {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
  attempts: number;
}

export interface ConsentGateOptions {
  totpKey: Buffer;
  notifier: Notifier;
  /** Issues the authorization code once consent is given. */
  issueCode: (client: OAuthClientInformationFull, params: AuthorizationParams) => string;
  ttlMs?: number;
  maxAttemptsPerRequest?: number;
  globalFailLimit?: number;
  lockMs?: number;
  now?: () => number;
}

export const CONSENT_PATH = "/consent";

export class ConsentGate {
  private pending = new Map<string, Pending>();
  private failures: number[] = [];
  private lockedUntil = 0;
  private lastCounter = -1;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly globalFailLimit: number;
  private readonly lockMs: number;
  private readonly now: () => number;

  constructor(private opts: ConsentGateOptions) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.maxAttempts = opts.maxAttemptsPerRequest ?? 5;
    this.globalFailLimit = opts.globalFailLimit ?? 10;
    this.lockMs = opts.lockMs ?? 15 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /** Called from provider.authorize(): park the request and show the consent page. */
  begin(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): void {
    this.sweep();
    const id = randomBytes(32).toString("base64url");
    this.pending.set(id, { client, params, createdAt: this.now(), attempts: 0 });
    this.render(res, id, client, params);
  }

  /** POST /consent: verify the TOTP code, then redirect back to the client. */
  handle(req: Request, res: Response): void {
    this.sweep();
    const id = typeof req.body?.request_id === "string" ? req.body.request_id : "";
    const pending = this.pending.get(id);
    if (!pending) {
      this.sendPage(res, 400, "<h1>Request expired</h1><p>Start the connection again from your Claude client.</p>");
      return;
    }
    const { client, params } = pending;
    const who = `${client.client_name ?? "unnamed client"} (${client.client_id.slice(0, 8)}) from ${req.ip}`;

    if (req.body?.action === "deny") {
      this.pending.delete(id);
      this.redirectBack(res, params, { error: "access_denied" });
      return;
    }

    if (this.now() < this.lockedUntil) {
      this.sendPage(res, 429, "<h1>Locked</h1><p>Too many failed attempts. Try again later.</p>");
      return;
    }

    const counter = verifyTotp(this.opts.totpKey, String(req.body?.code ?? ""), { nowMs: this.now() });
    if (counter === null || counter <= this.lastCounter) {
      pending.attempts++;
      this.recordFailure(who);
      if (pending.attempts >= this.maxAttempts) {
        this.pending.delete(id);
        this.sendPage(res, 403, "<h1>Denied</h1><p>Too many wrong codes for this request.</p>");
        return;
      }
      this.render(res, id, client, params, "Wrong or already-used code. Try the next one.", 401);
      return;
    }

    this.lastCounter = counter;
    this.pending.delete(id);
    const code = this.opts.issueCode(client, params);
    this.opts.notifier.alert(`consent APPROVED for ${who}`);
    this.redirectBack(res, params, { code });
  }

  private recordFailure(who: string): void {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < this.lockMs);
    this.failures.push(now);
    this.opts.notifier.alert(`consent code REJECTED for ${who}`);
    if (this.failures.length >= this.globalFailLimit) {
      this.lockedUntil = now + this.lockMs;
      this.failures = [];
      this.opts.notifier.alert(`consent LOCKED for ${Math.round(this.lockMs / 60000)} min after repeated failures`);
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, p] of this.pending) {
      if (now - p.createdAt > this.ttlMs) this.pending.delete(id);
    }
  }

  private redirectBack(res: Response, params: AuthorizationParams, extra: Record<string, string>): void {
    const url = new URL(params.redirectUri);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    if (params.state) url.searchParams.set("state", params.state);
    res.redirect(302, url.toString());
  }

  private render(
    res: Response,
    id: string,
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    error?: string,
    status = 200
  ): void {
    const name = esc(client.client_name ?? "Unnamed client");
    const dest = esc(new URL(params.redirectUri).origin);
    const scopes = esc((params.scopes ?? []).join(" ") || "default");
    this.sendPage(
      res,
      status,
      `<h1>Allow vault access?</h1>
<p><b>${name}</b> wants access to your Obsidian vault.</p>
<p class="meta">Returns to: <code>${dest}</code><br>Scopes: <code>${scopes}</code></p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="${CONSENT_PATH}">
  <input type="hidden" name="request_id" value="${esc(id)}">
  <label for="code">Authenticator code</label>
  <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" autofocus required>
  <button name="action" value="approve" type="submit">Allow</button>
  <button name="action" value="deny" type="submit" formnovalidate class="deny">Deny</button>
</form>
<p class="meta">If you didn't just connect a Claude client, press Deny.</p>`
    );
  }

  private sendPage(res: Response, status: number, body: string): void {
    res.status(status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
    );
    res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vault access</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#222}
input{font-size:1.5rem;letter-spacing:.3em;width:8em;padding:.3em;display:block;margin:.4em 0 1em}
button{font-size:1rem;padding:.5em 1.2em;margin-right:.5em}
.deny{background:none}.err{color:#b00020}.meta{color:#666;font-size:.9em}
</style></head><body>${body}</body></html>`);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
