import type { AnalysisStatus, ProjectJobStatus, ProjectJobType, ProjectStatus } from "@shared/contracts";
import { t } from ".";

export function projectStatusLabel(status: ProjectStatus) {
  return t(`status.project.${status}`);
}

export function analysisStatusLabel(status: AnalysisStatus) {
  return t(`status.analysis.${status}`);
}

export function projectJobStatusLabel(status: ProjectJobStatus) {
  return t(`status.job.${status}`);
}

export function projectJobTypeLabel(type: ProjectJobType) {
  return t(`status.jobType.${type}`);
}
