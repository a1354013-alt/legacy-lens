import { describe, expect, it, vi } from "vitest";
import { getDisplayLanguage, getProjectDisplayStatus, getProjectPrimaryAction, getProjectsPollingInterval, refreshProjectList } from "./Home";

function project(overrides: Partial<Parameters<typeof getProjectDisplayStatus>[0]> = {}): Parameters<typeof getProjectDisplayStatus>[0] {
  return {
    id: 1,
    name: "demo",
    description: null,
    language: "go",
    sourceType: "upload",
    status: "ready",
    importProgress: 100,
    analysisProgress: 0,
    errorMessage: null,
    analysisStatus: "pending",
    latestJob: null,
    ...overrides,
  };
}

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

  it("maps project, job, and analysis state into one user-facing status", () => {
    expect(
      getProjectDisplayStatus(
        project({
          status: "importing",
          latestJob: { id: 1, type: "import_zip", status: "queued", progress: 0, errorMessage: null },
        })
      )
    ).toBe("Import pending");

    expect(
      getProjectDisplayStatus(
        project({
          status: "analyzing",
          latestJob: { id: 2, type: "analyze", status: "running", progress: 30, errorMessage: null },
        })
      )
    ).toBe("Analyzing");

    expect(getProjectDisplayStatus(project({ status: "completed", analysisStatus: "partial" }))).toBe("Analysis ready");
    expect(
      getProjectDisplayStatus(
        project({
          status: "failed",
          latestJob: { id: 3, type: "import_git", status: "failed", progress: 10, errorMessage: "clone failed" },
        })
      )
    ).toBe("Import failed");
  });

  it("does not fall back unknown languages to Go", () => {
    expect(getDisplayLanguage("delphi")).toBe("Delphi");
    expect(getDisplayLanguage("go")).toBe("Go");
    expect(getDisplayLanguage("sql")).toBe("SQL");
    expect(getDisplayLanguage(null)).toBe("Unknown");
    expect(getDisplayLanguage(undefined)).toBe("Unknown");
    expect(getDisplayLanguage("cobol")).toBe("Unknown");
  });

  it("maps the primary card action from project, latest job, and analysis status", () => {
    expect(
      getProjectPrimaryAction(
        project({
          status: "importing",
          latestJob: { id: 1, type: "import_zip", status: "queued", progress: 0, errorMessage: null },
        })
      )
    ).toBe("View progress");

    expect(
      getProjectPrimaryAction(
        project({
          status: "importing",
          latestJob: { id: 2, type: "import_git", status: "running", progress: 50, errorMessage: null },
        })
      )
    ).toBe("View progress");

    expect(getProjectPrimaryAction(project({ status: "ready", analysisStatus: "pending" }))).toBe("Start analysis");
    expect(getProjectPrimaryAction(project({ status: "completed", analysisStatus: "completed" }))).toBe("View analysis result");
    expect(getProjectPrimaryAction(project({ status: "failed", analysisStatus: "pending" }))).toBe("View error");
    expect(
      getProjectPrimaryAction(
        project({
          status: "failed",
          analysisStatus: "completed",
          latestJob: { id: 3, type: "analyze", status: "failed", progress: 10, errorMessage: "analysis failed" },
        })
      )
    ).toBe("View previous analysis result");
  });

  it("refreshes the project list through invalidate and refetch", async () => {
    const invalidate = vi.fn();
    const refetch = vi.fn();
    const notify = { success: vi.fn(), error: vi.fn() };

    await refreshProjectList({ projects: { list: { invalidate } } }, { refetch }, notify);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(notify.success).toHaveBeenCalledWith("Project list refreshed.");
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("shows a refresh error toast when refetch fails", async () => {
    const notify = { success: vi.fn(), error: vi.fn() };

    await refreshProjectList(
      { projects: { list: { invalidate: vi.fn() } } },
      {
        refetch: vi.fn(async () => {
          throw new Error("network down");
        }),
      },
      notify
    );

    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledWith("network down");
  });
});
