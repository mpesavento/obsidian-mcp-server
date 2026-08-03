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
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
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

/**
 * OAuth 2.1 provider for a single-user MCP server.
 * Auto-approves all authorization requests (no consent UI).
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

  private readonly storePath =
    process.env.OBSIDIAN_MCP_OAUTH_STORE ||
    join(homedir(), ".config", "obsidian-mcp", "oauth-store.json");

  constructor() {
    this.load();
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
      registerClient: (
        clientData: Omit<
          OAuthClientInformationFull,
          "client_id" | "client_id_issued_at"
        >
      ) => {
        const clientId = randomUUID();
        const full: OAuthClientInformationFull = {
          ...clientData,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.clients.set(clientId, full);
        this.persist();
        return full;
      },
    };
  }

  /**
   * Auto-approve: immediately generate an auth code and redirect back.
   * No login form, no consent screen.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const code = randomUUID();
    this.codes.set(code, {
      challenge: params.codeChallenge,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      scopes: params.scopes || [],
      resource: params.resource,
    });

    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state) {
      url.searchParams.set("state", params.state);
    }

    res.redirect(url.toString());
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
      refresh_token: refreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = this.tokens.get(token);
    if (!info) {
      throw new InvalidTokenError("Invalid access token");
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
