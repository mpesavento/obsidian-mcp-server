# obsidian-mcp-server

MCP server providing read/write access to an Obsidian vault. Supports both local (stdio) and remote (HTTP) transports with OAuth 2.1 and bearer token authentication.

## Tools

### CRUD Operations
| Tool | Description |
|------|-------------|
| `vault_read` | Read a note's content + parsed YAML frontmatter |
| `vault_write` | Create or overwrite a note (auto-manages timestamps and attribution in frontmatter; keeps an existing note's frontmatter if you pass none) |
| `vault_append` | Append content to a note with separator (ideal for log entries) |
| `vault_delete` | Soft-delete to `.trash/` |
| `vault_move` | Move or rename a note, rewriting links to it in other notes ([details](#moving-notes-and-links)) |

### Search & Discovery
| Tool | Description |
|------|-------------|
| `vault_search` | Full-text search (ripgrep with Node.js fallback) |
| `vault_list` | List files/folders in a directory |
| `vault_recent` | Recently modified notes |
| `vault_frontmatter` | Read or atomically update frontmatter fields |
| `vault_info` | Vault stats and folder structure |

### Semantic Search (QMD)
| Tool | Description |
|------|-------------|
| `vault_semantic_search` | BM25 keyword search — fast, local, always available |
| `vault_vector_search` | Embedding-based similarity search (requires `qmd embed`) |
| `vault_hybrid_search` | BM25 + query expansion + LLM reranking |
| `vault_search_status` | Check QMD index status and embedding availability |
| `vault_search_update` | Update the QMD index after vault changes |

> **Note:** Semantic search tools require [QMD](https://github.com/tobi/qmd) to be installed (`npm i -g @tobilu/qmd`) and the vault indexed (`qmd collection add /path/to/vault --name exobrain`). See [docs/deployment.md](docs/deployment.md) for setup.

### Moving notes and links

`vault_move` keeps the vault's links valid. Unless you pass `update_links: false`, it rewrites links in
other notes that point at the moved note:

- wikilinks and embeds: `[[note]]`, `[[folder/note]]`, `[[../note]]`, `![[note]]`, with `#heading`, `#^block`,
  `|alias` and the escaped pipe used in tables (`\|`) preserved
- markdown links to notes: `[text](folder/note.md#heading)`
- links inside code blocks and inline code are left alone

A bare `[[name]]` keeps working after a folder-only move and is renamed when the file name changes. Where a bare
name would become ambiguous it is rewritten as a vault-root path.

Edits are made on the raw text, so the frontmatter of rewritten notes is not re-serialized (bare dates stay bare)
and their `modified` / `last_modified_by` are not touched.

Not rewritten, but reported in the result:
- notes matching `LINK_REWRITE_SKIP` (default: `10-identity/**`, `60-daily/**`, `**/decisions.md`,
  `00-meta/agent-comms/**`) are listed under `protected_skipped`
- links whose bare name is shared by several notes are listed under `ambiguous`

`vault_move` never overwrites an existing note (`ALREADY_EXISTS`), and `dry_run: true` returns the plan without
changing anything. Resolution is case-insensitive, like Obsidian's. Not handled: links to headings that were
renamed, markdown links whose path contains spaces or `<>`, and links written in HTML.

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
| `LINK_REWRITE_SKIP` | No | `10-identity/**,60-daily/**,**/decisions.md,00-meta/agent-comms/**` | Comma-separated globs (`*`, `**`) of notes `vault_move` must not edit when rewriting links; they are reported instead. Empty string protects nothing |

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
├── links.ts              # Link parsing, resolution and rewriting for vault_move (pure functions)
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
