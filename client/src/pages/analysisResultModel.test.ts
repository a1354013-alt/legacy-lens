import { describe, expect, it } from "vitest";
import type { AnalysisSnapshot, ProjectJobRecord } from "@shared/contracts";
import {
  canDownloadAnalysisReport,
  getAnalysisViewState,
  resolveAnalysisStatus,
  shouldPollProjectStatus,
  shouldPollSnapshot,
} from "./analysisResultModel";

function createSnapshot(): AnalysisSnapshot {
  return {
    report: {
      id: 1,
      projectId: 1,
      status: "completed",
      flowMarkdown: "# FLOW",
      dataDependencyMarkdown: "# DATA_DEPENDENCY",
      risksMarkdown: "# RISKS",
      rulesYaml: "rules: []",
      summaryJson: null,
      warningsJson: [],
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    importWarnings: [],
    totals: {
      files: 10,
      symbols: 30,
      dependencies: 20,
      fields: 5,
      fieldDependencies: 5,
      risks: 2,
      rules: 3,
      importWarnings: 0,
    },
    topSymbols: [],
    topRisks: [],
    topRules: [],
    fieldTables: [],
  };
}

function createJob(overrides?: Partial<ProjectJobRecord>): ProjectJobRecord {
  return {
    id: 1,
    projectId: 1,
    userId: 7,
    type: "analyze",
    status: "queued",
    progress: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("analysisResultModel", () => {
  it("polls while a queued or running job exists", () => {
    expect(shouldPollProjectStatus("ready", "pending")).toBe(false);
    expect(shouldPollProjectStatus("ready", "pending", createJob())).toBe(true);
    expect(shouldPollSnapshot("ready", "processing")).toBe(true);
    expect(shouldPollSnapshot("completed", "completed", createJob({ status: "running", progress: 50 }))).toBe(true);
    expect(shouldPollSnapshot("completed", "completed", createJob({ status: "completed", progress: 100 }))).toBe(false);
  });

  it("derives queued, running, completed, and failed states", () => {
    expect(getAnalysisViewState("ready", "pending", undefined, false)).toBe("idle");
    expect(getAnalysisViewState("ready", "pending", createJob(), false)).toBe("queued");
    expect(getAnalysisViewState("analyzing", "processing", createJob({ status: "running", progress: 60 }), false)).toBe("running");
    expect(getAnalysisViewState("completed", "completed", createJob({ status: "completed", progress: 100 }), true)).toBe("completed");
    expect(getAnalysisViewState("failed", "failed", createJob({ status: "failed", errorMessage: "boom" }), false)).toBe("failed");
  });

  it("prefers the persisted report status and falls back to project analysis status", () => {
    expect(resolveAnalysisStatus(undefined, undefined)).toBe("pending");
    expect(resolveAnalysisStatus(undefined, "processing")).toBe("processing");
    expect(resolveAnalysisStatus("partial", "processing")).toBe("partial");
  });

  it("enables report download only when the persisted snapshot is complete", () => {
    const completedSnapshot = createSnapshot();
    const missingYamlSnapshot = {
      ...createSnapshot(),
      report: {
        ...createSnapshot().report!,
        rulesYaml: null,
      },
    };
    const failedSnapshot = {
      ...createSnapshot(),
      report: {
        ...createSnapshot().report!,
        status: "failed" as const,
      },
    };

    expect(canDownloadAnalysisReport(completedSnapshot)).toBe(true);
    expect(canDownloadAnalysisReport(missingYamlSnapshot)).toBe(false);
    expect(canDownloadAnalysisReport(failedSnapshot)).toBe(false);
    expect(canDownloadAnalysisReport(undefined)).toBe(false);
  });
});
