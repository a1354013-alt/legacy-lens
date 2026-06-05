import { describe, expect, it, vi } from "vitest";
import { clearSignedOutCache, isAlreadyOnRedirectPath } from "./useAuth";

describe("clearSignedOutCache", () => {
  it("clears auth and project list cache before invalidating signed-out queries", async () => {
    const utils = {
      auth: { me: { setData: vi.fn(), invalidate: vi.fn() } },
      projects: { list: { setData: vi.fn(), invalidate: vi.fn() } },
    };

    await clearSignedOutCache(utils);

    expect(utils.auth.me.setData).toHaveBeenCalledWith(undefined, null);
    expect(utils.projects.list.setData).toHaveBeenCalledWith(undefined, []);
    expect(utils.auth.me.invalidate).toHaveBeenCalledTimes(1);
    expect(utils.projects.list.invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("isAlreadyOnRedirectPath", () => {
  it("compares against the redirect URL pathname instead of the full URL", () => {
    const current = new URL("https://legacy.example/api/oauth/start?next=%2Fprojects%2F1") as unknown as Location;

    expect(isAlreadyOnRedirectPath(current, "https://legacy.example/api/oauth/start?next=%2Fprojects%2F1%2Fanalysis")).toBe(true);
    expect(isAlreadyOnRedirectPath(current, "https://legacy.example/api/dev/login?next=%2Fprojects%2F1")).toBe(false);
  });
});
