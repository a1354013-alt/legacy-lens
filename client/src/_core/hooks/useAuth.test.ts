import { describe, expect, it, vi } from "vitest";
import { clearSignedOutCache } from "./useAuth";

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
