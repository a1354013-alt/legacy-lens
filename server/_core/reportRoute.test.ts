import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../appError";
import { registerReportDownloadRoute } from "./reportRoute";

vi.mock("./sdk", () => ({
  sdk: {
    authenticateRequest: vi.fn(async () => ({ id: 7 })),
  },
}));

vi.mock("../services/projectWorkflow", () => ({
  buildReportArchiveBuffer: vi.fn(async (projectId: number) => ({
    fileName: `legacy-lens-report-${projectId}.zip`,
    mimeType: "application/zip",
    buffer: Buffer.from("zip-bytes"),
  })),
  buildAnalysisDiffArchiveBuffer: vi.fn(async (projectId: number, _userId: number, baseRunId: number, compareRunId: number) => ({
    fileName: `legacy-lens-report-${projectId}-diff-${baseRunId}-${compareRunId}.zip`,
    mimeType: "application/zip",
    buffer: Buffer.from("diff-zip-bytes"),
  })),
}));

async function withReportServer<T>(callback: (baseUrl: string) => Promise<T>) {
  const app = express();
  registerReportDownloadRoute(app);
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("reportRoute", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("downloads the ZIP report with stable headers", async () => {
    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/42/report.zip`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/zip");
      expect(response.headers.get("content-disposition")).toBe('attachment; filename="legacy-lens-report-42.zip"');
      expect(await response.text()).toBe("zip-bytes");
    });
  });

  it("downloads the analysis diff ZIP with validated ids", async () => {
    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/42/analysis-diff.zip?baseRunId=1&compareRunId=2`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/zip");
      expect(response.headers.get("content-disposition")).toBe('attachment; filename="legacy-lens-report-42-diff-1-2.zip"');
      expect(await response.text()).toBe("diff-zip-bytes");
    });
  });

  it("rejects invalid analysis diff ids before calling the service", async () => {
    const { buildAnalysisDiffArchiveBuffer } = await import("../services/projectWorkflow");

    await withReportServer(async (baseUrl) => {
      const responses = await Promise.all([
        fetch(`${baseUrl}/api/projects/not-a-number/analysis-diff.zip?baseRunId=1&compareRunId=2`),
        fetch(`${baseUrl}/api/projects/42/analysis-diff.zip?baseRunId=0&compareRunId=2`),
        fetch(`${baseUrl}/api/projects/42/analysis-diff.zip?baseRunId=1&compareRunId=-1`),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(buildAnalysisDiffArchiveBuffer).not.toHaveBeenCalled();
    });
  });

  it("returns 401 for unauthorized analysis diff downloads", async () => {
    const { sdk } = await import("./sdk");
    vi.mocked(sdk.authenticateRequest).mockRejectedValueOnce(new Error("Invalid session."));

    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/42/analysis-diff.zip?baseRunId=1&compareRunId=2`);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        code: "UNAUTHORIZED",
        error: "Invalid session.",
      });
    });
  });

  it("surfaces real analysis diff route failures from the service", async () => {
    const { buildAnalysisDiffArchiveBuffer } = await import("../services/projectWorkflow");
    vi.mocked(buildAnalysisDiffArchiveBuffer).mockRejectedValueOnce(new AppError("REPORT_NOT_READY", "An analysis run cannot be compared with itself."));
    vi.mocked(buildAnalysisDiffArchiveBuffer).mockRejectedValueOnce(new AppError("PROJECT_NOT_FOUND", "Analysis runs from another project cannot be compared here."));
    vi.mocked(buildAnalysisDiffArchiveBuffer).mockRejectedValueOnce(new AppError("REPORT_TOO_LARGE", "Analysis diff ZIP exceeds the size limit."));
    vi.mocked(buildAnalysisDiffArchiveBuffer).mockRejectedValueOnce(new AppError("UNSUPPORTED_SNAPSHOT_VERSION", "Snapshot schema version 99 is not supported by this Legacy Lens build."));

    await withReportServer(async (baseUrl) => {
      const sameRun = await fetch(`${baseUrl}/api/projects/42/analysis-diff.zip?baseRunId=1&compareRunId=1`);
      const crossProject = await fetch(`${baseUrl}/api/projects/42/analysis-diff.zip?baseRunId=1&compareRunId=2`);
      const tooLarge = await fetch(`${baseUrl}/api/projects/42/analysis-diff.zip?baseRunId=3&compareRunId=4`);
      const unsupported = await fetch(`${baseUrl}/api/projects/42/analysis-diff.zip?baseRunId=5&compareRunId=6`);

      expect(sameRun.status).toBe(409);
      await expect(sameRun.json()).resolves.toMatchObject({ code: "REPORT_NOT_READY" });
      expect(crossProject.status).toBe(404);
      await expect(crossProject.json()).resolves.toMatchObject({ code: "PROJECT_NOT_FOUND" });
      expect(tooLarge.status).toBe(413);
      await expect(tooLarge.json()).resolves.toMatchObject({ code: "REPORT_TOO_LARGE" });
      expect(unsupported.status).toBe(409);
      await expect(unsupported.json()).resolves.toMatchObject({ code: "UNSUPPORTED_SNAPSHOT_VERSION" });
    });
  });

  it("returns 404 when the project does not exist", async () => {
    const { buildReportArchiveBuffer } = await import("../services/projectWorkflow");
    vi.mocked(buildReportArchiveBuffer).mockRejectedValueOnce(new AppError("PROJECT_NOT_FOUND", "Project not found."));

    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/404/report.zip`);
      const payload = (await response.json()) as { error: string; code: string };

      expect(response.status).toBe(404);
      expect(payload).toMatchObject({
        code: "PROJECT_NOT_FOUND",
        error: "Project not found.",
      });
    });
  });

  it("returns a reasonable error when analysis is not ready", async () => {
    const { buildReportArchiveBuffer } = await import("../services/projectWorkflow");
    vi.mocked(buildReportArchiveBuffer).mockRejectedValueOnce(new AppError("REPORT_NOT_READY", "Analysis report is not ready for download."));

    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/42/report.zip`);
      const payload = (await response.json()) as { error: string; code: string };

      expect(response.status).toBe(409);
      expect(payload).toMatchObject({
        code: "REPORT_NOT_READY",
        error: expect.stringContaining("Analysis report is not ready"),
      });
    });
  });

  it("returns a friendly payload when the report archive is too large", async () => {
    const { buildReportArchiveBuffer } = await import("../services/projectWorkflow");
    vi.mocked(buildReportArchiveBuffer).mockRejectedValueOnce(
      new AppError("REPORT_TOO_LARGE", "Report ZIP exceeds the 25MB export limit. Try a smaller project slice or increase MAX_REPORT_ARCHIVE_BYTES.")
    );

    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/42/report.zip`);
      const payload = (await response.json()) as { error: string; code: string; remediation?: string };

      expect(response.status).toBe(413);
      expect(payload.code).toBe("REPORT_TOO_LARGE");
      expect(payload.error).toContain("25MB export limit");
      expect(payload.remediation).toContain("smaller project slice");
    });
  });

  it("returns 401 when the request is unauthorized", async () => {
    const { sdk } = await import("./sdk");
    vi.mocked(sdk.authenticateRequest).mockRejectedValueOnce(new Error("Invalid session."));

    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/42/report.zip`);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        code: "UNAUTHORIZED",
        error: "Invalid session.",
        message: "Invalid session.",
      });
    });
  });

  it("returns 500 for unexpected internal failures instead of misclassifying them as bad input", async () => {
    const { buildReportArchiveBuffer } = await import("../services/projectWorkflow");
    vi.mocked(buildReportArchiveBuffer).mockRejectedValueOnce(new Error("disk read failed"));

    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/42/report.zip`);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        error: "disk read failed",
        message: "disk read failed",
      });
    });
  });
});
