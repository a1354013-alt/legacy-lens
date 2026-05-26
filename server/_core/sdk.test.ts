import { describe, expect, it, vi } from "vitest";

const getUserByOpenIdMock = vi.fn();
const upsertUserMock = vi.fn();

vi.mock("./env", () => ({
  ENV: {
    appId: "legacy-lens-app",
    cookieSecret: "super-secret",
    databaseUrl: "mysql://root:root@localhost:3306/legacy_lens",
    oAuthServerUrl: "https://oauth.example.com",
    isProduction: false,
    devAuthBypass: "",
    devAuthOpenId: "",
  },
}));

vi.mock("../db", () => ({
  getUserByOpenId: getUserByOpenIdMock,
  upsertUser: upsertUserMock,
}));

describe("session schema", () => {
  it("accepts blank display names without failing verification", async () => {
    const { sdk } = await import("./sdk");

    const token = await sdk.createSessionToken("user-1", { name: "" });
    const session = await sdk.verifySession(token);

    expect(session).toEqual({
      openId: "user-1",
      appId: "legacy-lens-app",
      name: null,
    });
  });

  it("throttles lastSignedIn writes for frequent authenticated requests", async () => {
    const { sdk } = await import("./sdk");
    const token = await sdk.createSessionToken("user-1", { name: "User" });
    const request = {
      headers: {
        cookie: `app_session_id=${token}`,
      },
    } as any;

    getUserByOpenIdMock.mockResolvedValue({
      id: 7,
      openId: "user-1",
      name: "User",
      email: "user@example.com",
      loginMethod: "test",
      role: "user",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastSignedIn: new Date(),
    });

    await sdk.authenticateRequest(request);
    await sdk.authenticateRequest(request);

    expect(upsertUserMock).not.toHaveBeenCalled();
  });
});
