#!/usr/bin/env node

import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  // Load and validate config early
  loadConfig();

  const args = process.argv.slice(2);
  const transportIdx = args.indexOf("--transport");
  const transport =
    transportIdx >= 0 && args[transportIdx + 1]
      ? args[transportIdx + 1]
      : "stdio";

  switch (transport) {
    case "stdio": {
      const { startStdioTransport } = await import(
        "./transport/stdio.js"
      );
      await startStdioTransport();
      break;
    }
    case "http": {
      const { startHttpTransport } = await import(
        "./transport/http.js"
      );
      await startHttpTransport();
      break;
    }
    default:
      console.error(
        `Unknown transport: "${transport}". Use "stdio" or "http".`
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[obsidian-mcp] Fatal error:", err);
  process.exit(1);
});
