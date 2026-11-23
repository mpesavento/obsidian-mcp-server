import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidTokenError,
  InvalidClientMetadataError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { ConsentGate } from "./consent.js";
import type { Notifier } from "../audit/alert.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";

interface StoredAuthCode {
  challenge: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource?: URL;
}

interface StoredRefreshToken {
  clientId: string;
  scopes: string[];
  resource?: URL;
}

/** claude.ai's (and claude.com's) OAuth callback for remote connectors. */
export const DEFAULT_ALLOWED_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

export interface PersonalOAuthProviderOptions {
  /** Override the store path (falls back to OBSIDIAN_MCP_OAUTH_STORE, then ~/.config/...). */
  storePath?: string;
  /** Exact redirect URIs a client may register. */
  allowedRedirectUris?: string[];
  /** Also allow RFC 8252 loopback redirects (http://localhost|127.0.0.1|[::1]:<any port>), as Claude Code uses. */
  allowLoopbackRedirects?: boolean;
  /** Cap on registered clients; the oldest are evicted (with their tokens) past it. */
  maxClients?: number;
  notifier?: Notifier;
  /** This server's canonical URL. Tokens bound (RFC 8707) to another resource are rejected. */
  resourceUrl?: URL;
}

export function isAllowedRedirect(
  uri: string,
  allowed: string[],
  allowLoopback: boolean
): boolean {
  if (allowed.includes(uri)) return true;
  if (!allowLoopback) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return (
    u.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
    !u.username &&
    !u.password
  );
}

/**
 * OAuth 2.1 provider for a single-user MCP server.
 *
 * Authorization requires human consent: authorize() hands the request to a
 * ConsentGate, which issues a code only after the current TOTP code is entered.
 * Without a gate, authorize() refuses (fails closed). Registration accepts only
 * allowlisted redirect URIs.
 *
 * Registered clients, access tokens, and refresh tokens are persisted to disk so
 * that a service restart does not invalidate an already-connected client (which
 * otherwise surfaces in Claude.ai as "couldn't register with the sign-in
 * service"). Authorization codes are short-lived and one-time-use, so they stay
 * in memory only. Override the store location with OBSIDIAN_MCP_OAUTH_STORE.
 */
export class PersonalOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, StoredAuthCode>();
  private tokens = new Map<string, AuthInfo>();
  private refreshTokens = new Map<string, StoredRefreshToken>();

  private readonly storePath: string;
  private readonly allowedRedirectUris: string[];
  private readonly allowLoopback: boolean;
  private readonly maxClients: number;
  private readonly notifier?: Notifier;
  private readonly resourceUrl?: URL;
  private consent?: ConsentGate;

  constructor(opts: PersonalOAuthProviderOptions = {}) {
    this.storePath =
      opts.storePath ||
      process.env.OBSIDIAN_MCP_OAUTH_STORE ||
      join(homedir(), ".config", "obsidian-mcp", "oauth-store.json");
    this.allowedRedirectUris = opts.allowedRedirectUris ?? DEFAULT_ALLOWED_REDIRECT_URIS;
    this.allowLoopback = opts.allowLoopbackRedirects ?? true;
    this.maxClients = opts.maxClients ?? 25;
    this.notifier = opts.notifier;
    this.resourceUrl = opts.resourceUrl;
    this.load();
  }

  setConsentGate(gate: ConsentGate): void {
    this.consent = gate;
  }

  /** Load persisted clients/tokens from disk, dropping already-expired tokens. */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.storePath, "utf8");
    } catch {
      return; // no store yet — first run
    }
    try {
      const data = JSON.parse(raw);
      const now = Math.floor(Date.now() / 1000);
      for (const c of data.clients ?? []) {
        this.clients.set(c.client_id, c as OAuthClientInformationFull);
      }
      for (const [token, info] of data.tokens ?? []) {
        if (info.expiresAt && info.expiresAt < now) continue;
        this.tokens.set(token, {
          ...info,
          resource: info.resource ? new URL(info.resource) : undefined,
        } as AuthInfo);
      }
      for (const [token, rt] of data.refreshTokens ?? []) {
        this.refreshTokens.set(token, {
          ...rt,
          resource: rt.resource ? new URL(rt.resource) : undefined,
        } as StoredRefreshToken);
      }
    } catch (err) {
      console.error(
        `[obsidian-mcp] Failed to parse OAuth store at ${this.storePath}:`,
        err
      );
    }
  }

  /** Atomically write clients/tokens to disk. Codes are intentionally omitted. */
  private persist(): void {
    const data = {
      clients: [...this.clients.values()],
      tokens: [...this.tokens.entries()].map(([token, info]) => [
        token,
        { ...info, resource: info.resource?.toString() },
      ]),
      refreshTokens: [...this.refreshTokens.entries()].map(([token, rt]) => [
        token,
        { ...rt, resource: rt.resource?.toString() },
      ]),
    };
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      const tmp = `${this.storePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.storePath);
    } catch (err) {
      console.error(
        `[obsidian-mcp] Failed to persist OAuth store to ${this.storePath}:`,
        err
      );
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.clients.get(clientId),
      registerClient: async (
        clientData: Omit<
          OAuthClientInformationFull,
          "client_id" | "client_id_issued_at"
        >
      ) => {
        const uris = (clientData.redirect_uris ?? []).map(String);
        const bad = uris.filter(
          (u) => !isAllowedRedirect(u, this.allowedRedirectUris, this.allowLoopback)
        );
        if (uris.length === 0 || bad.length > 0) {
          this.notifier?.alert(
            `registration REJECTED (redirect ${bad.join(", ") || "none"}), client_name=${clientData.client_name ?? "?"}`
          );
          throw new InvalidClientMetadataError(
            "redirect_uris must be an allowed Claude callback or a loopback address"
          );
        }
        const clientId = randomUUID();
        const full: OAuthClientInformationFull = {
          ...clientData,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.clients.set(clientId, full);
        this.evictOverflow();
        this.persist();
        this.notifier?.alert(
          `client registered: ${full.client_name ?? "unnamed"} (${clientId.slice(0, 8)}) → ${uris.join(", ")}`
        );
        return full;
      },
    };
  }

  /** Drop the oldest clients (and their tokens) once over the cap. */
  private evictOverflow(): void {
    if (this.clients.size <= this.maxClients) return;
    const byAge = [...this.clients.values()].sort(
      (a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0)
    );
    for (const c of byAge.slice(0, this.clients.size - this.maxClients)) {
      this.clients.delete(c.client_id);
      for (const [t, info] of this.tokens) if (info.clientId === c.client_id) this.tokens.delete(t);
      for (const [t, rt] of this.refreshTokens) if (rt.clientId === c.client_id) this.refreshTokens.delete(t);
    }
  }

  /**
   * Hands the request to the consent gate, which renders the TOTP page. With no
   * gate configured this fails closed: no code is ever issued without consent.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    if (!this.consent) {
      throw new ServerError("Authorization is disabled: no consent gate configured");
    }
    this.consent.begin(client, params, res);
  }

  /** Mint a one-time authorization code. Called by the consent gate after approval. */
  issueAuthorizationCode(
    client: OAuthClientInformationFull,
    params: AuthorizationParams
  ): string {
    const code = randomUUID();
    this.codes.set(code, {
      challenge: params.codeChallenge,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      scopes: params.scopes || [],
      resource: params.resource,
    });
    return code;
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const stored = this.codes.get(authorizationCode);
    if (!stored) {
      throw new Error("Invalid authorization code");
    }
    return stored.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const stored = this.codes.get(authorizationCode);
    if (!stored) {
      throw new Error("Invalid authorization code");
    }

    // Consume the code (one-time use)
    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresIn = 3600; // 1 hour

    this.tokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: stored.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      resource: stored.resource,
    });

    this.refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      scopes: stored.scopes,
      resource: stored.resource,
    });

    this.persist();

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    const stored = this.refreshTokens.get(refreshToken);
    if (!stored || stored.clientId !== client.client_id) {
      throw new Error("Invalid refresh token");
    }

    // Rotate (OAuth 2.1 / MCP spec MUST for public clients): the old refresh
    // token is consumed and a new one issued, so a stolen one is single-use.
    this.refreshTokens.delete(refreshToken);
    const newRefreshToken = randomUUID();
    this.refreshTokens.set(newRefreshToken, { ...stored });

    const accessToken = randomUUID();
    const expiresIn = 3600;

    this.tokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: scopes || stored.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      resource: stored.resource,
    });

    this.persist();

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = this.tokens.get(token);
    if (!info) {
      throw new InvalidTokenError("Invalid access token");
    }

    // Audience check (RFC 8707): a token minted for another resource is not ours.
    if (this.resourceUrl && info.resource && !sameResource(info.resource, this.resourceUrl)) {
      throw new InvalidTokenError("Token was issued for a different resource");
    }

    if (info.expiresAt && info.expiresAt < Math.floor(Date.now() / 1000)) {
      this.tokens.delete(token);
      this.persist();
      throw new InvalidTokenError("Access token expired");
    }

    return info;
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.tokens.delete(request.token);
    this.refreshTokens.delete(request.token);
    this.persist();
  }
}

function sameResource(a: URL, b: URL): boolean {
  const norm = (u: URL) => `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  return norm(a) === norm(b);
}
