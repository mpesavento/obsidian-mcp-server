import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Notifier } from "./alert.js";

/**
 * One JSON line per request, for forensics. IP is a signal, not an identity:
 * Mike travels, so many addresses will be his.
 *
 * Never logged: tokens, auth codes, TOTP codes, query strings, request bodies.
 * Only the JSON-RPC method and tool name come from the body.
 */

const WRITE_TOOLS = new Set([
  "vault_write",
  "vault_append",
  "vault_patch",
  "vault_delete",
  "vault_move",
  "vault_search_update",
]);

export interface RequestLogEntry {
  ts: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  ip: string | undefined;
  /** TCP peer. Loopback for anything that came through tailscaled. */
  peer?: string;
  /** True when tailscaled marked the request as public Funnel traffic. */
  funnel?: boolean;
  /** Tailnet identity (Serve, not Funnel). Forgeable by a local process that bypasses tailscaled. */
  ts_user?: string;
  xff?: string;
  ua?: string;
  client_id?: string;
  rpc?: string[];
  tools?: string[];
  write?: boolean;
}

/** Pulls JSON-RPC method and tool names out of a (possibly batched) MCP body. */
export function describeRpc(body: unknown): {
  rpc?: string[];
  tools?: string[];
  write?: boolean;
} {
  const msgs = Array.isArray(body) ? body : body ? [body] : [];
  const rpc: string[] = [];
  const tools: string[] = [];
  let write = false;
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const method = (m as any).method;
    if (typeof method !== "string") continue;
    rpc.push(method);
    if (method === "tools/call") {
      const name = (m as any).params?.name;
      if (typeof name === "string") {
        tools.push(name);
        if (
          WRITE_TOOLS.has(name) ||
          (name === "vault_frontmatter" && (m as any).params?.arguments?.updates)
        ) {
          write = true;
        }
      }
    }
  }
  if (rpc.length === 0) return {};
  return { rpc, ...(tools.length ? { tools, write } : {}) };
}

export class RequestLog {
  constructor(
    private path: string | undefined,
    private maxBytes = 20 * 1024 * 1024
  ) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  write(entry: RequestLogEntry): void {
    const line = JSON.stringify(entry) + "\n";
    if (!this.path) {
      process.stderr.write(line);
      return;
    }
    try {
      try {
        if (statSync(this.path).size > this.maxBytes) {
          renameSync(this.path, `${this.path}.1`);
        }
      } catch {
        /* no file yet */
      }
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch (err) {
      console.error(`[obsidian-mcp] request log write failed:`, err);
    }
  }
}

/**
 * Counts 401s per IP and alerts once when an IP crosses the threshold within
 * the window, which is what token guessing or a stolen-token retry loop looks like.
 */
export class AuthFailureWatch {
  private hits = new Map<string, number[]>();
  private alerted = new Map<string, number>();

  constructor(
    private notifier: Notifier,
    private threshold = 20,
    private windowMs = 10 * 60 * 1000
  ) {}

  record(ip: string | undefined, now = Date.now()): void {
    const key = ip ?? "unknown";
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
    const last = this.alerted.get(key) ?? 0;
    if (list.length >= this.threshold && now - last > this.windowMs) {
      this.alerted.set(key, now);
      this.notifier.alert(
        `${list.length} unauthorized requests from ${key} in ${Math.round(this.windowMs / 60000)} min`
      );
    }
  }
}

export function requestLogger(
  log: RequestLog,
  watch?: AuthFailureWatch
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const authClient = (req as any).auth?.clientId as string | undefined;
      const paramClient =
        (typeof (req as any).body?.client_id === "string" && (req as any).body.client_id) ||
        (typeof req.query?.client_id === "string" && (req.query.client_id as string)) ||
        undefined;
      const xff = req.headers["x-forwarded-for"];
      const entry: RequestLogEntry = {
        ts: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        ip: req.ip,
        peer: req.socket.remoteAddress,
        funnel: req.headers["tailscale-funnel-request"] === "?1",
        ...(req.headers["tailscale-user-login"]
          ? { ts_user: String(req.headers["tailscale-user-login"]) }
          : {}),
        ...(xff ? { xff: Array.isArray(xff) ? xff.join(",") : xff } : {}),
        ...(req.headers["user-agent"] ? { ua: String(req.headers["user-agent"]).slice(0, 200) } : {}),
        ...(authClient || paramClient ? { client_id: authClient ?? paramClient } : {}),
        ...(req.path === "/" && req.method === "POST" ? describeRpc((req as any).body) : {}),
      };
      log.write(entry);
      if (res.statusCode === 401) watch?.record(req.ip);
    });
    next();
  };
}
