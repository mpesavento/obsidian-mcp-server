import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
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
 * In-memory OAuth 2.1 provider for a single-user MCP server.
 * Auto-approves all authorization requests (no consent UI).
 */
export class PersonalOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, StoredAuthCode>();
  private tokens = new Map<string, AuthInfo>();
  private refreshTokens = new Map<string, StoredRefreshToken>();

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
      throw new Error("Invalid access token");
    }

    if (info.expiresAt && info.expiresAt < Math.floor(Date.now() / 1000)) {
      this.tokens.delete(token);
      throw new Error("Access token expired");
    }

    return info;
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.tokens.delete(request.token);
    this.refreshTokens.delete(request.token);
  }
}
