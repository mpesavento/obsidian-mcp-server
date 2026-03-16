import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";

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
      };
    }

    throw new Error("Invalid access token");
  }
}
