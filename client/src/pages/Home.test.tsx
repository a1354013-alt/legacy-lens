import { describe, expect, it } from "vitest";
import { getProjectsPollingInterval } from "./Home";

describe("Home polling", () => {
  it("polls aggressively only while a project has an active job or active status", () => {
    expect(
      getProjectsPollingInterval([
        {
          id: 1,
          name: "ready-project",
          description: null,
          language: "go",
          sourceType: "upload",
          status: "ready",
          importProgress: 100,
          analysisProgress: 100,
          errorMessage: null,
          analysisStatus: "completed",
          latestJob: { id: 1, type: "analyze", status: "completed", progress: 100, errorMessage: null },
        },
      ])
    ).toBe(15000);

    expect(
      getProjectsPollingInterval([
        {
          id: 2,
          name: "active-project",
          description: null,
          language: "sql",
          sourceType: "git",
          status: "analyzing",
          importProgress: 100,
          analysisProgress: 30,
          errorMessage: null,
          analysisStatus: "processing",
          latestJob: { id: 2, type: "analyze", status: "running", progress: 30, errorMessage: null },
        },
      ])
    ).toBe(2000);
  });
});
