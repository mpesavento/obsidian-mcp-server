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

export function getConfig(): Config {
  if (!_config) {
    return loadConfig();
  }
  return _config;
}
