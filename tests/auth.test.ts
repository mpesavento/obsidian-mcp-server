import { describe, it, expect, beforeEach } from "vitest";
import { PersonalOAuthProvider } from "../src/auth/provider.js";
import { DualTokenVerifier } from "../src/auth/bearer.js";

/**
 * Stand-in for a consent approval: mint the code the way the ConsentGate does
 * after a valid TOTP, and redirect. (The gate itself is tested in http.test.ts.)
 */
async function approve(
  p: PersonalOAuthProvider,
  client: any,
  params: { codeChallenge: string; redirectUri: string; state?: string; scopes?: string[] },
  res: { redirect: (url: string) => void }
): Promise<void> {
  const code = p.issueAuthorizationCode(client, params as any);
  const u = new URL(params.redirectUri);
  u.searchParams.set("code", code);
  if (params.state) u.searchParams.set("state", params.state);
  res.redirect(u.toString());
}

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

    it("rejects registration with a non-allowlisted redirect URI", async () => {
      await expect(
        provider.clientsStore.registerClient!({
          redirect_uris: [new URL("https://evil.example/callback")],
          client_name: "Evil",
        })
      ).rejects.toThrow(/redirect_uris/);
    });

    it("accepts loopback redirects (Claude Code)", async () => {
      const c = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("http://localhost:53682/callback")],
        client_name: "Claude Code",
      });
      expect(c.client_id).toBeDefined();
    });

    it("rejects loopback redirects when disabled, and https 'localhost' lookalikes", async () => {
      const strict = new PersonalOAuthProvider({ allowLoopbackRedirects: false });
      await expect(
        strict.clientsStore.registerClient!({ redirect_uris: [new URL("http://localhost:1234/cb")] })
      ).rejects.toThrow();
      await expect(
        provider.clientsStore.registerClient!({ redirect_uris: [new URL("http://localhost.evil.example/cb")] })
      ).rejects.toThrow();
    });

    it("evicts the oldest clients past the cap", async () => {
      const small = new PersonalOAuthProvider({ maxClients: 2 });
      const a = await small.clientsStore.registerClient!({ redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")] });
      a.client_id_issued_at = 1; // force oldest
      await small.clientsStore.registerClient!({ redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")] });
      await small.clientsStore.registerClient!({ redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")] });
      expect(await small.clientsStore.getClient(a.client_id)).toBeUndefined();
    });

    it("authorize() fails closed with no consent gate", async () => {
      const client = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
      });
      const res = { redirect: () => { throw new Error("must not redirect"); } } as any;
      await expect(
        provider.authorize(client, { codeChallenge: "x", redirectUri: "https://claude.ai/api/mcp/auth_callback" }, res)
      ).rejects.toThrow(/consent/);
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

      await approve(provider,
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

      await approve(provider,
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
        redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
      });

      let code: string;
      const mockRes = {
        redirect: (url: string) => {
          code = new URL(url).searchParams.get("code")!;
        },
      } as any;

      await approve(provider,
        client,
        {
          codeChallenge: "c",
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
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
        redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
      });

      let code: string;
      const mockRes = {
        redirect: (url: string) => {
          code = new URL(url).searchParams.get("code")!;
        },
      } as any;

      await approve(provider,
        client,
        {
          codeChallenge: "c",
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
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

  describe("refresh rotation and audience", () => {
    it("rotates refresh tokens: the old one stops working", async () => {
      const client = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
      });
      const code = provider.issueAuthorizationCode(client, { codeChallenge: "c", redirectUri: "https://claude.ai/api/mcp/auth_callback" } as any);
      const t1 = await provider.exchangeAuthorizationCode(client, code);
      const t2 = await provider.exchangeRefreshToken(client, t1.refresh_token!);
      expect(t2.refresh_token).not.toBe(t1.refresh_token);
      await expect(provider.exchangeRefreshToken(client, t1.refresh_token!)).rejects.toThrow();
      await expect(provider.exchangeRefreshToken(client, t2.refresh_token!)).resolves.toBeDefined();
    });

    it("rejects a token bound to a different resource", async () => {
      const p = new PersonalOAuthProvider({ resourceUrl: new URL("https://vault.example/") });
      const client = await p.clientsStore.registerClient!({
        redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
      });
      const mk = async (resource?: string) => {
        const code = p.issueAuthorizationCode(client, {
          codeChallenge: "c",
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
          resource: resource ? new URL(resource) : undefined,
        } as any);
        return (await p.exchangeAuthorizationCode(client, code)).access_token;
      };
      await expect(p.verifyAccessToken(await mk("https://other.example/"))).rejects.toThrow(/different resource/);
      await expect(p.verifyAccessToken(await mk("https://vault.example"))).resolves.toBeDefined();
      await expect(p.verifyAccessToken(await mk())).resolves.toBeDefined();
    });
  });

  describe("token revocation", () => {
    it("revokes an access token", async () => {
      const client = await provider.clientsStore.registerClient!({
        redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
      });

      let code: string;
      const mockRes = {
        redirect: (url: string) => {
          code = new URL(url).searchParams.get("code")!;
        },
      } as any;

      await approve(provider,
        client,
        {
          codeChallenge: "c",
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
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
      redirect_uris: [new URL("https://claude.ai/api/mcp/auth_callback")],
    });

    let code: string;
    const mockRes = {
      redirect: (url: string) => {
        code = new URL(url).searchParams.get("code")!;
      },
    } as any;

    await approve(oauthProvider,
      client,
      {
        codeChallenge: "c",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
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
    ).rejects.toThrow("Invalid or expired access token");
  });

  it("works without static token configured", async () => {
    const oauthProvider = new PersonalOAuthProvider();
    const verifier = new DualTokenVerifier(oauthProvider);

    await expect(
      verifier.verifyAccessToken("any-token")
    ).rejects.toThrow();
  });
});
