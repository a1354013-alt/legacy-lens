import type { AnalysisStatus } from "@shared/contracts";
import { t } from "@/locales";

export function getAnalysisStatusDisplayLabel(status: AnalysisStatus) {
  return t(`status.analysis.${status}`);
}
