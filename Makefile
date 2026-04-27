.PHONY: help install build test test-watch lint clean dev start start-http restart-systemd

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install:  ## Install npm dependencies
	npm install

build:  ## Compile TypeScript to dist/
	npm run build

test:  ## Run vitest once
	npm test

test-watch:  ## Run vitest in watch mode
	npm run test:watch

test-file:  ## Run a specific test file: make test-file FILE=tests/auth.test.ts
	npx vitest run $(FILE)

lint:  ## Type-check without emit (tsc --noEmit)
	npm run lint

check: lint test  ## Lint + tests (run before pushing)

dev:  ## Watch mode — recompile on save
	npm run dev

start:  ## Start the server (stdio transport)
	npm run start

start-http:  ## Start the server (HTTP transport, port 3100)
	npm run start:http

clean:  ## Remove dist/ and node_modules/
	rm -rf dist node_modules

restart-systemd:  ## Reload + restart user-level obsidian-mcp-server.service
	XDG_RUNTIME_DIR=/run/user/$$(id -u) systemctl --user daemon-reload
	XDG_RUNTIME_DIR=/run/user/$$(id -u) systemctl --user restart obsidian-mcp-server.service
	XDG_RUNTIME_DIR=/run/user/$$(id -u) systemctl --user status --no-pager obsidian-mcp-server.service | head -10

logs:  ## Tail user-level service logs
	XDG_RUNTIME_DIR=/run/user/$$(id -u) journalctl --user -u obsidian-mcp-server.service -f
