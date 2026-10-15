import { describe, it, expect } from "vitest";
import { rejectSession, sessionErrorStatus } from "../src/transport/session-errors.js";

function fakeRes() {
  const out: { code?: number; body?: any } = {};
  const res = {
    status(code: number) {
      out.code = code;
      return {
        json(body: unknown) {
          out.body = body;
          return body;
        },
      };
    },
  };
  return { res, out };
}

describe("session errors", () => {
  it("answers 404 for an unknown session ID, so clients reinitialize (MCP spec)", () => {
    const { res, out } = fakeRes();
    rejectSession(res, "00000000-dead-beef-0000-000000000000");
    expect(out.code).toBe(404);
    expect(out.body.error.code).toBe(-32000);
    expect(out.body.id).toBeNull();
  });

  it("answers 400 when there is no session ID and it isn't an initialize request", () => {
    const { res, out } = fakeRes();
    rejectSession(res, undefined);
    expect(out.code).toBe(400);
    expect(out.body.error.message).toMatch(/Missing session ID/);
  });

  it("maps presence of the header to the status", () => {
    expect(sessionErrorStatus("abc")).toBe(404);
    expect(sessionErrorStatus(undefined)).toBe(400);
    expect(sessionErrorStatus("")).toBe(400);
  });
});
