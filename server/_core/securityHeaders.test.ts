import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { registerSecurityHeaders } from "./securityHeaders";

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

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
  });

  it("sets production security headers without blocking same-origin static assets", async () => {
    process.env.NODE_ENV = "production";

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/asset.js`);

      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("strict-transport-security")).toContain("max-age=");
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    });
  });
});
