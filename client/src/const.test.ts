import { afterEach, describe, expect, it, vi } from "vitest";
import { getLoginUrl } from "./const";

describe("auth URL helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves pathname, query, and hash in the login next parameter", () => {
    const location = new URL("https://legacy.example/projects/1/analysis?tab=risks#field");
    vi.stubGlobal("window", {
      location,
      origin: location.origin,
    });

    const url = new URL(getLoginUrl());

    expect(url.searchParams.get("next")).toBe("/projects/1/analysis?tab=risks#field");
  });
});
