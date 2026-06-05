import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ImportProject, { runImportProjectSubmitFlow } from "./ImportProject";

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

    expect(html).toContain("min-h-dvh");
    expect(html).toContain("lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]");
    expect(html).toContain("accept=\".zip\"");
    expect(html).toContain("h-40");
    expect(html).toContain("type=\"submit\"");
  });

  it("keeps creating phase visible until the import API returns a job", async () => {
    const phases: string[] = [];
    let resolveSubmit: (value: { jobId: number }) => void = () => undefined;
    const submitPromise = new Promise<{ jobId: number }>((resolve) => {
      resolveSubmit = resolve;
    });

    const flowPromise = runImportProjectSubmitFlow({
      validate: vi.fn(),
      submit: vi.fn(() => submitPromise),
      afterSuccess: vi.fn(),
      setPhase: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(["creating"]);
    resolveSubmit({ jobId: 1 });
    await flowPromise;

    expect(phases).toEqual(["creating", "waiting-import"]);
  });

  it("does not move to waiting-import when submit fails", async () => {
    const phases: string[] = [];

    await expect(
      runImportProjectSubmitFlow({
        validate: vi.fn(),
        submit: vi.fn(async () => {
          throw new Error("upload failed");
        }),
        afterSuccess: vi.fn(),
        setPhase: (phase) => phases.push(phase),
      })
    ).rejects.toThrow("upload failed");

    expect(phases).toEqual(["creating"]);
  });
});
