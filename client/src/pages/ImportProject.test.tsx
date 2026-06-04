import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ImportProject from "./ImportProject";

const setLocation = vi.fn();

vi.mock("wouter", () => ({
  useLocation: () => ["/import", setLocation],
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ projects: { list: { invalidate: vi.fn() } } }),
    projects: {
      getById: {
        useQuery: () => ({ data: null }),
      },
    },
    jobs: {
      getById: {
        useQuery: () => ({ data: null }),
      },
    },
    analysis: {
      trigger: {
        useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
      },
    },
  },
}));

describe("ImportProject", () => {
  beforeEach(() => {
    setLocation.mockReset();
  });

  it("renders the compact first-screen ZIP import flow", () => {
    const html = renderToString(<ImportProject />);

    expect(html).toContain("min-h-screen");
    expect(html).toContain("lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]");
    expect(html).toContain("accept=\".zip\"");
    expect(html).toContain("h-40");
    expect(html).toContain("type=\"submit\"");
  });
});
