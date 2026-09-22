import { describe, it, expect, afterEach } from "vitest";
import { authMiddleware } from "../../middleware/auth.js";

function makeContext(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  const store: Record<string, unknown> = {};
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      query: (name: string) => query[name],
    },
    set: (key: string, value: unknown) => {
      store[key] = value;
    },
    get: (key: string) => store[key],
    json: (body: unknown, status: number) => ({ body, status }),
    store,
  };
}

describe("authMiddleware (OSS single-tenant)", () => {
  const original = process.env.RETAINDB_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.RETAINDB_API_KEY;
    else process.env.RETAINDB_API_KEY = original;
  });

  it("marks open access as admin when no key is configured", async () => {
    delete process.env.RETAINDB_API_KEY;
    const c = makeContext();
    let called = false;

    await authMiddleware(c as never, async () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(c.store.auth).toMatchObject({ authType: "open", isAdmin: true });
  });

  it("marks the API-key holder as admin (so /v1/admin/* is reachable)", async () => {
    process.env.RETAINDB_API_KEY = "secret";
    const c = makeContext({ authorization: "Bearer secret" });
    let called = false;

    await authMiddleware(c as never, async () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(c.store.auth).toMatchObject({ authType: "api_key", isAdmin: true });
  });

  it("accepts ?api_key= as well", async () => {
    process.env.RETAINDB_API_KEY = "secret";
    const c = makeContext({}, { api_key: "secret" });
    let called = false;

    await authMiddleware(c as never, async () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(c.store.auth).toMatchObject({ isAdmin: true });
  });

  it("rejects a wrong key with 401 and does not call next", async () => {
    process.env.RETAINDB_API_KEY = "secret";
    const c = makeContext({ authorization: "Bearer wrong" });
    let called = false;

    const res = await authMiddleware(c as never, async () => {
      called = true;
    });

    expect(called).toBe(false);
    expect((res as { status: number }).status).toBe(401);
  });
});
