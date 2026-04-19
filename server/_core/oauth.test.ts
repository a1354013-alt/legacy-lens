import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({
  ENV: {
    appId: "legacy-lens-app",
    oAuthPortalUrl: "https://portal.example.com",
    cookieSecret: "oauth-secret",
    databaseUrl: "mysql://root:root@localhost:3306/legacy_lens",
    oAuthServerUrl: "https://oauth.example.com",
    isProduction: false,
    devAuthBypass: "",
    devAuthOpenId: "",
  },
}));

vi.mock("../db", () => ({
  upsertUser: vi.fn(async () => undefined),
}));

vi.mock("./sdk", () => ({
  sdk: {
    exchangeCodeForToken: vi.fn(async () => ({ accessToken: "token" })),
    getUserInfo: vi.fn(async () => ({ openId: "user-1", name: "User One" })),
    createSessionToken: vi.fn(async () => "session-token"),
  },
}));

describe("OAuth state validation", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const { registerOAuthRoutes } = await import("./oauth");
    const app = express();
    registerOAuthRoutes(app);

    await new Promise<void>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        closeServer = async () => {
          await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
        };
        resolve();
      });
    });
  });

  afterAll(async () => {
    await closeServer?.();
  });

  it("creates a signed login state and rejects tampered callback state", async () => {
    const startResponse = await fetch(`${baseUrl}/api/oauth/start?next=%2Fprojects%2F1%2Fanalysis`, {
      redirect: "manual",
    });
    const location = startResponse.headers.get("location");

    expect(startResponse.status).toBe(302);
    expect(location).toContain("https://portal.example.com/app-auth");

    const state = new URL(location!).searchParams.get("state");
    expect(state).toBeTruthy();

    const tamperedState = `${state}tampered`;
    const callbackResponse = await fetch(`${baseUrl}/api/oauth/callback?code=abc&state=${encodeURIComponent(tamperedState)}`, {
      redirect: "manual",
    });

    expect(callbackResponse.status).toBe(400);
    await expect(callbackResponse.json()).resolves.toEqual({
      error: "OAuth callback validation failed",
    });
  });
});
