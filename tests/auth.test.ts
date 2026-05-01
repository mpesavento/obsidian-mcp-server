import { describe, it, expect, beforeEach } from "vitest";
import { PersonalOAuthProvider } from "../src/auth/provider.js";
import { DualTokenVerifier } from "../src/auth/bearer.js";

describe("PersonalOAuthProvider", () => {
  let provider: PersonalOAuthProvider;

  beforeEach(() => {
    provider = new PersonalOAuthProvider();
  });

  describe("client registration", () => {
    it("registers a new client and returns client_id", async () => {
      const client = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
        client_name: "Claude",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });

      expect(client.client_id).toBeDefined();
      expect(client.client_id_issued_at).toBeDefined();
      expect(client.client_name).toBe("Claude");
    });

    it("retrieves a registered client", async () => {
      const client = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
        client_name: "Claude",
      });

      const retrieved = await provider.clientsStore.getClient(
        client.client_id
      );
      expect(retrieved).toBeDefined();
      expect(retrieved!.client_id).toBe(client.client_id);
    });

    it("returns undefined for unknown client", async () => {
      const result = await provider.clientsStore.getClient("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("authorization code flow", () => {
    it("exchanges code for tokens", async () => {
      const client = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
        client_name: "Claude",
      });

      // Simulate authorize() — we access the codes store indirectly
      let capturedRedirectUrl: string | null = null;
      const mockRes = {
        redirect: (url: string) => {
          capturedRedirectUrl = url;
        },
      } as any;

      await provider.authorize(
        client,
        {
          codeChallenge: "test-challenge",
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
          state: "test-state",
          scopes: ["mcp:tools"],
        },
        mockRes
      );

      expect(capturedRedirectUrl).toBeDefined();
      const redirectUrl = new URL(capturedRedirectUrl!);
      expect(redirectUrl.searchParams.get("state")).toBe("test-state");

      const code = redirectUrl.searchParams.get("code")!;
      expect(code).toBeDefined();

      // Verify challenge
      const challenge = await provider.challengeForAuthorizationCode(
        client,
        code
      );
      expect(challenge).toBe("test-challenge");

      // Exchange code for tokens
      const tokens = await provider.exchangeAuthorizationCode(client, code);
      expect(tokens.access_token).toBeDefined();
      expect(tokens.refresh_token).toBeDefined();
      expect(tokens.token_type).toBe("Bearer");
      expect(tokens.expires_in).toBe(3600);
    });

    it("rejects reused authorization code", async () => {
      const client = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
      });

      let code: string;
      const mockRes = {
        redirect: (url: string) => {
          code = new URL(url).searchParams.get("code")!;
        },
      } as any;

      await provider.authorize(
        client,
        {
          codeChallenge: "challenge",
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
        },
        mockRes
      );

      // First exchange succeeds
      await provider.exchangeAuthorizationCode(client, code!);

      // Second exchange fails (code consumed)
      await expect(
        provider.exchangeAuthorizationCode(client, code!)
      ).rejects.toThrow("Invalid authorization code");
    });
  });

  describe("token verification", () => {
    it("verifies a valid access token", async () => {
      const client = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("https://example.com/callback")],
      });

      let code: string;
      const mockRes = {
        redirect: (url: string) => {
          code = new URL(url).searchParams.get("code")!;
        },
      } as any;

      await provider.authorize(
        client,
        {
          codeChallenge: "c",
          redirectUri: "https://example.com/callback",
          scopes: ["mcp:tools"],
        },
        mockRes
      );

      const tokens = await provider.exchangeAuthorizationCode(client, code!);
      const info = await provider.verifyAccessToken(tokens.access_token);

      expect(info.token).toBe(tokens.access_token);
      expect(info.clientId).toBe(client.client_id);
      expect(info.scopes).toEqual(["mcp:tools"]);
    });

    it("rejects an invalid token", async () => {
      await expect(
        provider.verifyAccessToken("invalid-token")
      ).rejects.toThrow("Invalid access token");
    });
  });

  describe("refresh tokens", () => {
    it("exchanges a refresh token for a new access token", async () => {
      const client = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("https://example.com/callback")],
      });

      let code: string;
      const mockRes = {
        redirect: (url: string) => {
          code = new URL(url).searchParams.get("code")!;
        },
      } as any;

      await provider.authorize(
        client,
        {
          codeChallenge: "c",
          redirectUri: "https://example.com/callback",
        },
        mockRes
      );

      const tokens = await provider.exchangeAuthorizationCode(client, code!);
      const newTokens = await provider.exchangeRefreshToken(
        client,
        tokens.refresh_token!
      );

      expect(newTokens.access_token).toBeDefined();
      expect(newTokens.access_token).not.toBe(tokens.access_token);

      // New token should be verifiable
      const info = await provider.verifyAccessToken(newTokens.access_token);
      expect(info.clientId).toBe(client.client_id);
    });
  });

  describe("token revocation", () => {
    it("revokes an access token", async () => {
      const client = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("https://example.com/callback")],
      });

      let code: string;
      const mockRes = {
        redirect: (url: string) => {
          code = new URL(url).searchParams.get("code")!;
        },
      } as any;

      await provider.authorize(
        client,
        {
          codeChallenge: "c",
          redirectUri: "https://example.com/callback",
        },
        mockRes
      );

      const tokens = await provider.exchangeAuthorizationCode(client, code!);

      // Revoke
      await provider.revokeToken!(client, { token: tokens.access_token });

      // Should no longer verify
      await expect(
        provider.verifyAccessToken(tokens.access_token)
      ).rejects.toThrow();
    });
  });
});

describe("DualTokenVerifier", () => {
  it("accepts static bearer token", async () => {
    const oauthProvider = new PersonalOAuthProvider();
    const verifier = new DualTokenVerifier(oauthProvider, "my-secret-token");

    const info = await verifier.verifyAccessToken("my-secret-token");
    expect(info.clientId).toBe("static-bearer");
    expect(info.scopes).toEqual(["mcp:tools"]);
    // SDK >=1.27 requireBearerAuth requires expiresAt to be set.
    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("accepts OAuth tokens", async () => {
    const oauthProvider = new PersonalOAuthProvider();
    const verifier = new DualTokenVerifier(oauthProvider, "static-token");

    // Register client and get a token via OAuth
    const client = await oauthProvider.clientsStore.registerClient!({
      redirect_uris: [new URL("https://example.com/callback")],
    });

    let code: string;
    const mockRes = {
      redirect: (url: string) => {
        code = new URL(url).searchParams.get("code")!;
      },
    } as any;

    await oauthProvider.authorize(
      client,
      {
        codeChallenge: "c",
        redirectUri: "https://example.com/callback",
      },
      mockRes
    );

    const tokens = await oauthProvider.exchangeAuthorizationCode(
      client,
      code!
    );

    // Verify via dual verifier — should use OAuth path
    const info = await verifier.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(client.client_id);
  });

  it("rejects unknown tokens", async () => {
    const oauthProvider = new PersonalOAuthProvider();
    const verifier = new DualTokenVerifier(oauthProvider, "my-token");

    await expect(
      verifier.verifyAccessToken("wrong-token")
    ).rejects.toThrow("Invalid access token");
  });

  it("works without static token configured", async () => {
    const oauthProvider = new PersonalOAuthProvider();
    const verifier = new DualTokenVerifier(oauthProvider);

    await expect(
      verifier.verifyAccessToken("any-token")
    ).rejects.toThrow();
  });
});
