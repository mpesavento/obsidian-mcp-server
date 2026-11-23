import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/transport/http.js";
import { loadConfig, resetConfigForTests, type Config } from "../src/config.js";
import { PersonalOAuthProvider } from "../src/auth/provider.js";
import { RequestLog } from "../src/audit/request-log.js";
import { base32Decode, generateTotpSecret, hotp, totpCounter } from "../src/auth/totp.js";

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const STATIC_TOKEN = "static-test-token-0123456789abcdef";

function makeConfig(overrides: Record<string, string | undefined> = {}): Config {
  const env: Record<string, string | undefined> = {
    VAULT_PATH: mkdtempSync(join(tmpdir(), "vault-")),
    AUTH_TOKEN: STATIC_TOKEN,
    SERVER_URL: "http://localhost:3100",
    CONSENT_TOTP_SECRET: generateTotpSecret(),
    ...overrides,
  };
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigForTests();
  try {
    return loadConfig();
  } finally {
    process.env = saved;
    resetConfigForTests();
  }
}

class CapturingNotifier {
  messages: string[] = [];
  alert(m: string) {
    this.messages.push(m);
  }
}

interface Harness {
  base: string;
  server: Server;
  config: Config;
  notifier: CapturingNotifier;
  logPath: string;
  /** Mutable clock for TOTP. */
  clock: { ms: number };
}

async function start(overrides: Record<string, string | undefined> = {}): Promise<Harness> {
  const config = makeConfig(overrides);
  const notifier = new CapturingNotifier();
  const logPath = join(mkdtempSync(join(tmpdir(), "reqlog-")), "requests.jsonl");
  const clock = { ms: Date.now() };
  const app = createApp(config, {
    notifier,
    requestLog: new RequestLog(logPath),
    provider: new PersonalOAuthProvider({
      storePath: join(mkdtempSync(join(tmpdir(), "store-")), "s.json"),
      notifier,
    }),
    now: () => clock.ms,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server, config, notifier, logPath, clock };
}

function totpNow(h: Harness, stepOffset = 0): string {
  const key = base32Decode(h.config.CONSENT_TOTP_SECRET!);
  return hotp(key, totpCounter(h.clock.ms) + stepOffset);
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(h: Harness, redirect = CALLBACK) {
  return fetch(`${h.base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirect],
      client_name: "Claude",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
}

/** Register, GET /authorize; returns the consent page's request_id. */
async function beginAuth(h: Harness) {
  const reg = await register(h);
  expect(reg.status).toBe(201);
  const client = await reg.json();
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-123",
  });
  const res = await fetch(`${h.base}/authorize?${q}`, { redirect: "manual" });
  const html = await res.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  return { res, html, requestId, client, verifier };
}

async function submit(h: Harness, requestId: string, code: string, action = "approve") {
  return fetch(`${h.base}/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, code, action }).toString(),
    redirect: "manual",
  });
}

describe("HTTP transport security", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await start();
  });
  afterAll(() => {
    h.server.close();
  });

  describe("fail closed", () => {
    it("refuses to build the app without a consent secret", () => {
      const config = makeConfig({ CONSENT_TOTP_SECRET: undefined });
      expect(() => createApp(config, { notifier: new CapturingNotifier() })).toThrow(/CONSENT_TOTP_SECRET/);
    });

    it("refuses a weak consent secret", () => {
      const config = makeConfig({ CONSENT_TOTP_SECRET: "JBSWY3DP" });
      expect(() => createApp(config, { notifier: new CapturingNotifier() })).toThrow(/too short/);
    });
  });

  describe("deny by default", () => {
    for (const method of ["POST", "GET", "DELETE"]) {
      it(`${method} / without a token is 401 with WWW-Authenticate`, async () => {
        const res = await fetch(`${h.base}/`, {
          method,
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) : undefined,
        });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
      });
    }

    it("POST / with a bad token is 401", async () => {
      const res = await fetch(`${h.base}/`, {
        method: "POST",
        headers: { Authorization: "Bearer nope", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    });

    it("unknown paths are 404", async () => {
      const res = await fetch(`${h.base}/admin`);
      expect(res.status).toBe(404);
    });

    it("only /health and HEAD / are public", async () => {
      expect((await fetch(`${h.base}/health`)).status).toBe(200);
      expect((await fetch(`${h.base}/`, { method: "HEAD" })).status).toBe(200);
    });
  });

  describe("CORS", () => {
    it("does not reflect an arbitrary origin", async () => {
      const res = await fetch(`${h.base}/`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("allows claude.ai", async () => {
      const res = await fetch(`${h.base}/`, { method: "OPTIONS", headers: { Origin: "https://claude.ai" } });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    });
  });

  describe("registration", () => {
    it("rejects a foreign redirect URI with 400 and alerts", async () => {
      const res = await register(h, "https://evil.example/cb");
      expect(res.status).toBe(400);
      expect(h.notifier.messages.some((m) => m.includes("registration REJECTED"))).toBe(true);
    });

    it("accepts the claude.ai callback and alerts", async () => {
      const res = await register(h);
      expect(res.status).toBe(201);
      expect(h.notifier.messages.some((m) => m.includes("client registered"))).toBe(true);
    });
  });

  describe("consent gate", () => {
    beforeEach(() => {
      // Fresh TOTP step for each test so codes from earlier tests don't count as replays.
      h.clock.ms += 90_000;
    });

    it("/authorize shows a consent page instead of redirecting", async () => {
      const { res, html, requestId } = await beginAuth(h);
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(html).toContain("Authenticator code");
      expect(requestId).toBeTruthy();
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    });

    it("a wrong code issues no authorization code", async () => {
      const { requestId } = await beginAuth(h);
      const res = await submit(h, requestId!, "000000" === totpNow(h) ? "111111" : "000000");
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(h.notifier.messages.some((m) => m.includes("REJECTED for"))).toBe(true);
    });

    it("the right code completes the flow end to end, and a replayed code fails", async () => {
      const { requestId, client, verifier } = await beginAuth(h);
      const code = totpNow(h);
      const res = await submit(h, requestId!, code);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin + loc.pathname).toBe(CALLBACK);
      expect(loc.searchParams.get("state")).toBe("st-123");
      const authCode = loc.searchParams.get("code")!;
      expect(authCode).toBeTruthy();

      // Same TOTP code again, on a new request: rejected (replay).
      const second = await beginAuth(h);
      const replay = await submit(h, second.requestId!, code);
      expect(replay.status).toBe(401);

      // Token exchange with PKCE.
      const tok = await fetch(`${h.base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: verifier,
          client_id: client.client_id,
          redirect_uri: CALLBACK,
        }).toString(),
      });
      expect(tok.status).toBe(200);
      const { access_token } = await tok.json();

      // The token works on the MCP endpoint.
      const init = await fetch(`${h.base}/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }),
      });
      expect(init.status).toBe(200);
      expect(h.notifier.messages.some((m) => m.includes("APPROVED"))).toBe(true);
    });

    it("deny redirects with access_denied", async () => {
      const { requestId } = await beginAuth(h);
      const res = await submit(h, requestId!, "", "deny");
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    });

    it("an unknown request id is rejected", async () => {
      const res = await submit(h, "made-up", totpNow(h));
      expect(res.status).toBe(400);
    });
  });

  describe("lockout", () => {
    it("locks after repeated failures, even for the right code", async () => {
      const lh = await start();
      try {
        // 10 failures across fresh requests (5 attempts max per request).
        for (let i = 0; i < 2; i++) {
          const { requestId } = await beginAuth(lh);
          for (let j = 0; j < 5; j++) await submit(lh, requestId!, totpNow(lh, 5));
        }
        expect(lh.notifier.messages.some((m) => m.includes("LOCKED"))).toBe(true);
        const { requestId } = await beginAuth(lh);
        const res = await submit(lh, requestId!, totpNow(lh));
        expect(res.status).toBe(429);
      } finally {
        lh.server.close();
      }
    });
  });

  describe("request log", () => {
    it("records method, path, status, ip and tool names, never tokens", async () => {
      await fetch(`${h.base}/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STATIC_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "vault_write", arguments: { path: "x.md", content: "secret body" } } }),
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(h.logPath)).toBe(true);
      const raw = readFileSync(h.logPath, "utf8");
      const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
      const call = lines.find((l) => l.tools?.includes("vault_write"));
      expect(call).toBeDefined();
      expect(call.write).toBe(true);
      expect(call.ip).toBeTruthy();
      expect(call.client_id).toBe("static-bearer");
      expect(raw).not.toContain(STATIC_TOKEN);
      expect(raw).not.toContain("secret body");
      expect(lines.some((l) => l.status === 401)).toBe(true);
    });
  });
});
