import express from "express";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ZIP_RAW_BYTES } from "../../shared/const";
import { AppError } from "../appError";
import { registerProjectUploadRoute } from "./projectUploadRoute";

let lastTempFilePath: string | null = null;

vi.mock("../_core/sdk", () => ({
  sdk: {
    authenticateRequest: vi.fn(async () => ({ id: 7 })),
  },
}));

vi.mock("./projectWorkflow", () => ({
  queueImportProjectGit: vi.fn(async () => ({ jobId: 22, projectId: 42, status: "queued" })),
  queueImportProjectZipFromTempFile: vi.fn(async (_projectId: number, _userId: number, tempFilePath: string) => {
    lastTempFilePath = tempFilePath;
    return { jobId: 11, projectId: 42, status: "queued" };
  }),
}));

async function withUploadServer<T>(callback: (baseUrl: string) => Promise<T>) {
  const app = express();
  registerProjectUploadRoute(app);
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

afterEach(async () => {
  if (lastTempFilePath) {
    await rm(lastTempFilePath, { force: true }).catch(() => undefined);
    lastTempFilePath = null;
  }
  vi.clearAllMocks();
});

describe("projectUploadRoute", () => {
  it("accepts ZIP uploads and returns an import job payload", async () => {
    const { queueImportProjectZipFromTempFile } = await import("./projectWorkflow");

    await withUploadServer(async (baseUrl) => {
      const formData = new FormData();
      formData.append("file", new Blob(["zip-bytes"], { type: "application/zip" }), "project.zip");

      const response = await fetch(`${baseUrl}/api/projects/42/upload`, {
        method: "POST",
        body: formData,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ jobId: 11, jobType: "import_zip" });
      expect(vi.mocked(queueImportProjectZipFromTempFile)).toHaveBeenCalledWith(
        42,
        7,
        expect.any(String),
        "project.zip"
      );
    });
  });

  it("rejects oversized ZIP uploads with a 413 response", async () => {
    await withUploadServer(async (baseUrl) => {
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([new Uint8Array(MAX_ZIP_RAW_BYTES + 1)], { type: "application/zip" }),
        "too-large.zip"
      );

      const response = await fetch(`${baseUrl}/api/projects/42/upload`, {
        method: "POST",
        body: formData,
      });

      expect(response.status).toBe(413);
      await expect(response.text()).resolves.toContain("ZIP upload exceeds the raw archive limit");
    });
  });

  it("rejects invalid Git import URLs with a 400 response", async () => {
    const { queueImportProjectGit } = await import("./projectWorkflow");
    vi.mocked(queueImportProjectGit).mockRejectedValueOnce(new AppError("INVALID_GIT_URL", "Git URL is not allowed."));

    await withUploadServer(async (baseUrl) => {
      const formData = new FormData();
      formData.append("gitUrl", "ssh://127.0.0.1/private.git");

      const response = await fetch(`${baseUrl}/api/projects/42/upload`, {
        method: "POST",
        body: formData,
      });

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toContain("Git URL is not allowed.");
    });
  });
});
