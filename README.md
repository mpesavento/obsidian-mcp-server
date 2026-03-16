# obsidian-mcp-server

MCP server providing read/write access to an Obsidian vault. Supports both local (stdio) and remote (HTTP) transports with OAuth 2.1 and bearer token authentication.

## Tools

| Tool | Description |
|------|-------------|
| `vault_read` | Read a note's content + parsed YAML frontmatter |
| `vault_write` | Create or overwrite a note (auto-manages timestamps and attribution in frontmatter) |
| `vault_append` | Append content to a note with separator (ideal for log entries) |
| `vault_delete` | Soft-delete to `.trash/` |
| `vault_move` | Move or rename a note |
| `vault_search` | Full-text search (ripgrep with Node.js fallback) |
| `vault_list` | List files/folders in a directory |
| `vault_recent` | Recently modified notes |
| `vault_frontmatter` | Read or atomically update frontmatter fields |
| `vault_info` | Vault stats and folder structure |

## Quick Start

```bash
npm install
npm run build
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": ["/path/to/obsidian-mcp-server/dist/index.js"],
      "env": {
        "VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add obsidian-vault \
  -e VAULT_PATH=/path/to/your/vault \
  -- node /path/to/obsidian-mcp-server/dist/index.js
```

### Remote (HTTP mode)

```bash
# Create .env from template
cp .env.example .env
# Edit .env: set VAULT_PATH, AUTH_TOKEN, SERVER_URL

# Start in HTTP mode
node dist/index.js --transport http
```

Connect Claude Code remotely:
```bash
claude mcp add obsidian-vault \
  --transport http \
  https://your-server-url/ \
  --header "Authorization: Bearer YOUR_TOKEN"
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAULT_PATH` | Yes | — | Absolute path to Obsidian vault root |
| `AUTH_TOKEN` | No | — | Static bearer token for Claude Code remote access |
| `PORT` | No | `3100` | HTTP server port |
| `AGENT_NAME_DEFAULT` | No | `claude` | Default agent name for frontmatter attribution |
| `SERVER_URL` | No | `http://localhost:PORT` | Public URL (for OAuth metadata endpoints) |

## Deployment

See [docs/deployment.md](docs/deployment.md) for detailed instructions on:
- Raspberry Pi + Tailscale Funnel
- Google Cloud Run
- Security considerations

## Development

```bash
npm run dev          # Watch mode (recompile on changes)
npm test             # Run tests
npm run lint         # Type-check without emitting
```

## Architecture

```
src/
├── index.ts              # Entry point (--transport stdio|http)
├── server.ts             # McpServer factory + tool registration
├── config.ts             # Environment config with Zod validation
├── vault.ts              # Filesystem ops, path validation, atomic writes, frontmatter
├── auth/
│   ├── provider.ts       # OAuth 2.1 server (auto-approve, in-memory)
│   └── bearer.ts         # Dual token verifier (OAuth + static bearer)
├── transport/
│   ├── stdio.ts          # Stdio transport (Claude Desktop / Code local)
│   └── http.ts           # Express + Streamable HTTP + OAuth routes
├── search/
│   ├── ripgrep.ts        # rg subprocess search
│   └── native.ts         # Node.js fallback (glob + regex)
└── tools/
    ├── crud.ts           # vault_read/write/append/delete/move
    ├── search.ts         # vault_search/list/recent
    └── metadata.ts       # vault_frontmatter/info
```
