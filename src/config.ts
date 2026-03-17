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
});

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
