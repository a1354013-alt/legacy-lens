import type {
  AnalysisStatus,
  DependencyKind,
  DependencyTargetKind,
  FieldDependencyOperationType,
  ImpactTargetType,
  ProjectJobStatus,
  ProjectJobType,
  ProjectSourceType,
  ProjectStatus,
  RiskSeverity,
  RuleType,
  SymbolKind,
} from "@shared/contracts";
import { getAnalysisStatusDisplayLabel } from "@/lib/displayLabels";
import { t } from ".";

export function projectStatusLabel(status: ProjectStatus) {
  return t(`status.project.${status}`);
}

export function analysisStatusLabel(status: AnalysisStatus) {
  return getAnalysisStatusDisplayLabel(status);
}

export function projectJobStatusLabel(status: ProjectJobStatus) {
  return t(`status.job.${status}`);
}

export function projectJobTypeLabel(type: ProjectJobType) {
  return t(`status.jobType.${type}`);
}

export function projectJobFailureTitle(type: ProjectJobType | null | undefined) {
  return type === "analyze" ? t("importProject.alerts.analysisErrorTitle") : t("importProject.alerts.importErrorTitle");
}

export function localizeProjectJobErrorMessage(type: ProjectJobType | null | undefined, message: string | null | undefined) {
  const normalized = String(message ?? "").trim();

  if (!normalized) {
    return type === "analyze" ? t("importProject.alerts.analysisFailed") : t("importProject.alerts.importFailed");
  }

  if (normalized === "Analysis failed.") {
    return t("importProject.alerts.analysisFailed");
  }

  if (normalized === "Import failed.") {
    return t("importProject.alerts.importFailed");
  }

  if (normalized === "Project job failed.") {
    return type === "analyze" ? t("importProject.alerts.analysisFailed") : t("importProject.alerts.importFailed");
  }

  return normalized;
}

export function sourceTypeLabel(type: ProjectSourceType) {
  return t(`labels.sourceType.${type}`);
}

export function symbolKindLabel(kind: SymbolKind | string) {
  return t(`labels.symbolKind.${kind}`);
}

export function dependencyKindLabel(kind: DependencyKind | string) {
  return t(`labels.dependencyKind.${kind}`);
}

export function dependencyTargetKindLabel(kind: DependencyTargetKind | string) {
  return t(`labels.dependencyTargetKind.${kind}`);
}

export function fieldOperationLabel(operation: FieldDependencyOperationType | string) {
  return t(`labels.fieldOperation.${operation}`);
}

export function confidenceLevelLabel(level: "high" | "medium" | "low" | string) {
  return t(`labels.confidenceLevel.${level}`);
}

export function riskSeverityLabel(severity: RiskSeverity | string) {
  return t(`labels.riskSeverity.${severity}`);
}

export function riskTypeLabel(type: string) {
  return t(`labels.riskType.${type}`);
}

export function flowStatusLabel(status: "complete" | "partial" | "unresolved" | string) {
  return t(`labels.flowStatus.${status}`);
}

export function buildDoctorStatusLabel(status: "not_applicable" | "ready" | "ready_with_warnings" | "blocked" | string) {
  return t(`labels.buildDoctorStatus.${status}`);
}

export function findingSeverityLabel(severity: "critical" | "blocker" | "error" | "warning" | "info" | string) {
  return t(`labels.findingSeverity.${severity}`);
}

export function ruleTypeLabel(type: RuleType | string) {
  return t(`labels.ruleType.${type}`);
}

export function analysisEntityTypeLabel(type: string) {
  return t(`labels.analysisEntityType.${type}`);
}

export function impactTargetTypeLabel(type: ImpactTargetType | string) {
  return t(`impact.${type}`);
}
