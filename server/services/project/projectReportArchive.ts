import JSZip from "jszip";
import { MAX_REPORT_ARCHIVE_BYTES } from "../../../shared/const";
import { AppError } from "../../appError";

export type ReportArchiveEntry = {
  path: string;
  content: string;
};

function buildReportFileName(projectId: number) {
  return `legacy-lens-project-${projectId}.zip`;
}

function estimateReportArchiveBytes(entries: ReportArchiveEntry[]) {
  const rawBytes = entries.reduce((total, entry) => total + Buffer.byteLength(entry.content, "utf8"), 0);
  const zipOverheadBytes = entries.length * 512 + 4096;
  return rawBytes + zipOverheadBytes;
}

export async function buildProjectReportArchiveBuffer(projectId: number, entries: ReportArchiveEntry[], runNumber?: number | null) {
  const estimatedArchiveBytes = estimateReportArchiveBytes(entries);
  if (estimatedArchiveBytes > MAX_REPORT_ARCHIVE_BYTES) {
    throw new AppError(
      "REPORT_TOO_LARGE",
      `Report export is too large to package safely (estimated ${estimatedArchiveBytes} bytes, limit ${MAX_REPORT_ARCHIVE_BYTES}). Try a smaller project slice, narrower import scope, or paged API results.`
    );
  }

  const archive = new JSZip();
  const deterministicFileOptions = { date: new Date(0) };
  for (const entry of entries) {
    archive.file(entry.path, entry.content, deterministicFileOptions);
  }

  const buffer = await archive.generateAsync({ type: "nodebuffer" });
  if (buffer.length > MAX_REPORT_ARCHIVE_BYTES) {
    throw new AppError("REPORT_TOO_LARGE", `Report ZIP exceeds the ${MAX_REPORT_ARCHIVE_BYTES} byte safety limit.`);
  }

  return {
    fileName: runNumber ? `legacy-lens-project-${projectId}-run-${runNumber}.zip` : buildReportFileName(projectId),
    mimeType: "application/zip",
    buffer,
  };
}
