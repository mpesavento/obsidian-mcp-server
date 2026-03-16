#!/bin/sh
set -e

# Clone or update vault from private GitHub repo
if [ -n "$VAULT_REPO" ] && [ -n "$GITHUB_TOKEN" ]; then
  REPO_URL=$(echo "$VAULT_REPO" | sed "s|https://|https://x-access-token:${GITHUB_TOKEN}@|")

  if [ ! -d "$VAULT_PATH/.git" ]; then
    echo "[entrypoint] Cloning vault repo..."
    git clone --depth 1 "$REPO_URL" "$VAULT_PATH"
  else
    echo "[entrypoint] Pulling latest vault changes..."
    cd "$VAULT_PATH" && git pull --ff-only || true
  fi

  # Background sync: commit and push writes every 5 minutes
  (
    while true; do
      sleep 300
      cd "$VAULT_PATH"
      git add -A
      if ! git diff --cached --quiet 2>/dev/null; then
        git -c user.name="obsidian-mcp" -c user.email="mcp@localhost" \
          commit -m "auto-sync $(date -Iseconds)" 2>/dev/null
        git push origin main 2>/dev/null || true
      fi
    done
  ) &
else
  echo "[entrypoint] No VAULT_REPO configured, using local VAULT_PATH"
fi

echo "[entrypoint] Starting MCP server..."
exec node dist/index.js --transport http
