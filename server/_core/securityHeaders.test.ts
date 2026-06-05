import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildProductionCspDirectives, registerSecurityHeaders, shouldAllowUnsafeEval } from "./securityHeaders";

async function withServer<T>(callback: (baseUrl: string) => Promise<T>) {
  const app = express();
  registerSecurityHeaders(app);
  app.get("/asset.js", (_req, res) => res.type("application/javascript").send("console.log('ok');"));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("security headers", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCspAllowUnsafeEval = process.env.CSP_ALLOW_UNSAFE_EVAL;

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousCspAllowUnsafeEval === undefined) {
      delete process.env.CSP_ALLOW_UNSAFE_EVAL;
    } else {
      process.env.CSP_ALLOW_UNSAFE_EVAL = previousCspAllowUnsafeEval;
    }
  });

  it("omits unsafe-eval in production when the env flag is not set", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CSP_ALLOW_UNSAFE_EVAL;

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/asset.js`);
      const csp = response.headers.get("content-security-policy");

      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("strict-transport-security")).toContain("max-age=");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).toContain("frame-ancestors 'none'");
    });
  });

  it("includes unsafe-eval in production when CSP_ALLOW_UNSAFE_EVAL=true", async () => {
    process.env.NODE_ENV = "production";
    process.env.CSP_ALLOW_UNSAFE_EVAL = "true";

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/asset.js`);

      expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-eval'");
    });
  });

  it.each(["1", "yes", " TRUE "])("treats %s as a truthy unsafe-eval flag", (value) => {
    process.env.CSP_ALLOW_UNSAFE_EVAL = value;

    expect(shouldAllowUnsafeEval()).toBe(true);
    expect(buildProductionCspDirectives()).toContain("script-src 'self' 'unsafe-eval'");
  });

  it("does not send CSP outside production", async () => {
    process.env.NODE_ENV = "development";
    process.env.CSP_ALLOW_UNSAFE_EVAL = "true";

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/asset.js`);

      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("strict-transport-security")).toBeNull();
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });
  });
});
