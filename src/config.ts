import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env file if present (no error if missing)
loadDotenv({ quiet: true });

const envSchema = z.object({
  VAULT_PATH: z.string().min(1, "VAULT_PATH is required"),
  AUTH_TOKEN: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3100),
  AGENT_NAME_DEFAULT: z.string().default("claude"),
  SERVER_URL: z.string().url().optional(),
  MAX_CONTENT_SIZE: z.coerce.number().int().positive().default(500000), // 500KB default
  // ── Auth hardening (2026-11) ──
  // Base32 TOTP secret for the /authorize consent gate. REQUIRED for the HTTP
  // transport: the server refuses to start without it (fail closed).
  CONSENT_TOTP_SECRET: z.string().optional(),
  // Comma-separated exact redirect URIs clients may register. Loopback redirects
  // (Claude Code) are allowed separately via OAUTH_ALLOW_LOOPBACK.
  OAUTH_ALLOWED_REDIRECT_URIS: z
    .string()
    .default("https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback"),
  OAUTH_ALLOW_LOOPBACK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  OAUTH_MAX_CLIENTS: z.coerce.number().int().positive().default(25),
  // Comma-separated browser origins allowed by CORS. Never reflected.
  CORS_ALLOWED_ORIGINS: z.string().default("https://claude.ai,https://claude.com"),
  // JSON-lines request log. Unset logs to stderr.
  REQUEST_LOG_PATH: z.string().optional(),
  // Security alerts go to Telegram when both are set.
  ALERT_TELEGRAM_BOT_TOKEN: z.string().optional(),
  ALERT_TELEGRAM_CHAT_ID: z.string().optional(),
  // Comma-separated globs (vault-relative, `*` and `**`). vault_move never rewrites links inside
  // matching notes; it reports them instead. Set to an empty string to protect nothing.
  LINK_REWRITE_SKIP: z
    .string()
    .default("10-identity/**,60-daily/**,**/decisions.md,00-meta/agent-comms/**"),
});

// Export max content size for use in vault operations
export const MAX_CONTENT_SIZE_BYTES = 500000; // 500KB - can be overridden by env

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  _config = result.data;
  return _config;
}

/** For tests: drop the cached config so the env is re-read. */
export function resetConfigForTests(): void {
  _config = null;
}

export function splitList(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function getConfig(): Config {
  if (!_config) {
    return loadConfig();
  }
  return _config;
}
