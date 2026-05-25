import express from "express";
import { access, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ZIP_RAW_BYTES } from "../../shared/const";
import { AppError } from "../appError";
import { registerProjectUploadRoute } from "./projectUploadRoute";

let lastTempFilePath: string | null = null;
const uploadTempDir = join(tmpdir(), "legacy-lens-upload");

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

async function listUploadTempFiles() {
  return await readdir(uploadTempDir).catch(() => []);
}

async function expectFileExists(path: string) {
  await expect(access(path)).resolves.toBeUndefined();
}

async function expectFileMissing(path: string) {
  await expect(access(path)).rejects.toBeTruthy();
}

afterEach(async () => {
  if (lastTempFilePath) {
    await rm(lastTempFilePath, { force: true }).catch(() => undefined);
    lastTempFilePath = null;
  }
  vi.clearAllMocks();
});

describe("projectUploadRoute", () => {
  it("rejects unauthenticated uploads without leaving a temp file", async () => {
    const { sdk } = await import("../_core/sdk");
    vi.mocked(sdk.authenticateRequest).mockRejectedValueOnce(new Error("unauthorized"));
    const beforeFiles = await listUploadTempFiles();

    await withUploadServer(async (baseUrl) => {
      const formData = new FormData();
      formData.append("file", new Blob(["zip-bytes"], { type: "application/zip" }), "project.zip");

      const response = await fetch(`${baseUrl}/api/projects/42/upload`, {
        method: "POST",
        body: formData,
      });

      expect(response.status).toBe(401);
    });

    await expect(listUploadTempFiles()).resolves.toEqual(beforeFiles);
  });

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
      expect(lastTempFilePath).toBeTruthy();
      await expectFileExists(lastTempFilePath!);
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

  it("rejects invalid project ids and cleans the uploaded temp file", async () => {
    const beforeFiles = await listUploadTempFiles();

    await withUploadServer(async (baseUrl) => {
      const formData = new FormData();
      formData.append("file", new Blob(["zip-bytes"], { type: "application/zip" }), "project.zip");

      const response = await fetch(`${baseUrl}/api/projects/not-a-number/upload`, {
        method: "POST",
        body: formData,
      });

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toContain("Invalid project id.");
    });

    await expect(listUploadTempFiles()).resolves.toEqual(beforeFiles);
  });

  it("rejects requests that provide both file and git url and cleans the temp file", async () => {
    const beforeFiles = await listUploadTempFiles();

    await withUploadServer(async (baseUrl) => {
      const formData = new FormData();
      formData.append("file", new Blob(["zip-bytes"], { type: "application/zip" }), "project.zip");
      formData.append("gitUrl", "https://example.com/org/repo.git");

      const response = await fetch(`${baseUrl}/api/projects/42/upload`, {
        method: "POST",
        body: formData,
      });

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toContain("Exactly one import source is required.");
    });

    await expect(listUploadTempFiles()).resolves.toEqual(beforeFiles);
  });

  it("cleans the temp file when job creation fails", async () => {
    const { queueImportProjectZipFromTempFile } = await import("./projectWorkflow");
    vi.mocked(queueImportProjectZipFromTempFile).mockImplementationOnce(async (_projectId, _userId, tempFilePath) => {
      lastTempFilePath = tempFilePath;
      throw new AppError("IMPORT_FAILED", "Unable to queue import.");
    });

    await withUploadServer(async (baseUrl) => {
      const formData = new FormData();
      formData.append("file", new Blob(["zip-bytes"], { type: "application/zip" }), "project.zip");

      const response = await fetch(`${baseUrl}/api/projects/42/upload`, {
        method: "POST",
        body: formData,
      });

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toContain("Unable to queue import.");
    });

    expect(lastTempFilePath).toBeTruthy();
    await expectFileMissing(lastTempFilePath!);
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
