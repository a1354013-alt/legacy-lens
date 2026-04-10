import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({
  ENV: {
    appId: "legacy-lens-app",
    cookieSecret: "super-secret",
    databaseUrl: "mysql://root:root@localhost:3306/legacy_lens",
    oAuthServerUrl: "https://oauth.example.com",
    ownerOpenId: "owner",
    isProduction: false,
    forgeApiUrl: "",
    forgeApiKey: "",
  },
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
});
