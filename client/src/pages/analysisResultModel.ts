import type { AnalysisSnapshot, AnalysisStatus, ProjectJobRecord, ProjectStatus } from "@shared/contracts";

export type AnalysisViewState = "idle" | "queued" | "running" | "completed" | "failed";
export const RESULT_LIST_PAGE_SIZE = 25;

export function shouldPollProjectStatus(
  status: ProjectStatus | null | undefined,
  analysisStatus: AnalysisStatus | null | undefined,
  latestJob?: ProjectJobRecord | null
) {
  return (
    status === "importing" ||
    status === "analyzing" ||
    analysisStatus === "processing" ||
    latestJob?.status === "queued" ||
    latestJob?.status === "running"
  );
}

export function shouldPollSnapshot(
  status: ProjectStatus | null | undefined,
  analysisStatus: AnalysisStatus | null | undefined,
  latestJob?: ProjectJobRecord | null
) {
  return shouldPollProjectStatus(status, analysisStatus, latestJob);
}

export function getAnalysisViewState(
  status: ProjectStatus | null | undefined,
  analysisStatus: AnalysisStatus | null | undefined,
  latestJob?: ProjectJobRecord | null,
  hasReport = false
) {
  if (hasReport && (analysisStatus === "completed" || analysisStatus === "partial")) {
    return "completed" satisfies AnalysisViewState;
  }

  if (status === "failed" || analysisStatus === "failed" || latestJob?.status === "failed") {
    return "failed" satisfies AnalysisViewState;
  }

  if (latestJob?.status === "queued") {
    return "queued" satisfies AnalysisViewState;
  }

  if (status === "importing" || status === "analyzing" || analysisStatus === "processing" || latestJob?.status === "running") {
    return "running" satisfies AnalysisViewState;
  }

  return "idle" satisfies AnalysisViewState;
}

export function shouldShowPreviousAnalysisFailureBanner(
  status: ProjectStatus | null | undefined,
  reportStatus: AnalysisStatus | null | undefined,
  latestJob?: ProjectJobRecord | null,
  hasReport = false
) {
  if (!hasReport || (reportStatus !== "completed" && reportStatus !== "partial")) {
    return false;
  }

  return status === "failed" || latestJob?.status === "failed";
}

export function resolveAnalysisStatus(
  reportStatus: AnalysisStatus | null | undefined,
  projectAnalysisStatus: AnalysisStatus | null | undefined
) {
  return reportStatus ?? projectAnalysisStatus ?? "pending";
}

export function canDownloadAnalysisReport(snapshot: AnalysisSnapshot | undefined) {
  const report = snapshot?.report;
  if (!report) {
    return false;
  }

  if (report.status !== "completed" && report.status !== "partial") {
    return false;
  }

  return Boolean(report.flowMarkdown && report.dataDependencyMarkdown && report.risksMarkdown && report.rulesYaml);
}
