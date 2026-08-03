import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

/**
 * Token verifier that accepts both OAuth-issued tokens and a static bearer token.
 * The static token allows Claude Code to authenticate via --header without OAuth.
 */
export class DualTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private oauthVerifier: OAuthTokenVerifier,
    private staticToken?: string
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Try OAuth token first
    try {
      return await this.oauthVerifier.verifyAccessToken(token);
    } catch {
      // Fall through to static token check
    }

    // Check static bearer token
    if (this.staticToken && token === this.staticToken) {
      return {
        token,
        clientId: "static-bearer",
        scopes: ["mcp:tools"],
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      };
    }

    // Unknown/stale token: throw InvalidTokenError (not a plain Error) so the
    // SDK's bearer middleware returns 401 + WWW-Authenticate — prompting the
    // client to re-authenticate — instead of a 500 that reads as a hard failure.
    throw new InvalidTokenError("Invalid or expired access token");
  }
}
