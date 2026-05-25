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

  it("returns 404 when the project does not exist", async () => {
    const { buildReportArchiveBuffer } = await import("../services/projectWorkflow");
    vi.mocked(buildReportArchiveBuffer).mockRejectedValueOnce(new AppError("PROJECT_NOT_FOUND", "Project not found."));

    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/404/report.zip`);

      expect(response.status).toBe(404);
      expect(await response.text()).toContain("Project not found.");
    });
  });

  it("returns a reasonable error when analysis is not ready", async () => {
    const { buildReportArchiveBuffer } = await import("../services/projectWorkflow");
    vi.mocked(buildReportArchiveBuffer).mockRejectedValueOnce(new AppError("REPORT_NOT_READY", "Analysis report is not ready for download."));

    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/42/report.zip`);

      expect(response.status).toBe(409);
      expect(await response.text()).toContain("Analysis report is not ready");
    });
  });

  it("returns 401 when the request is unauthorized", async () => {
    const { sdk } = await import("./sdk");
    vi.mocked(sdk.authenticateRequest).mockRejectedValueOnce(new Error("Invalid session."));

    await withReportServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/42/report.zip`);

      expect(response.status).toBe(401);
      await expect(response.text()).resolves.toContain("Invalid session");
    });
  });
});
