import express from "express";
import { access, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ZIP_RAW_BYTES } from "../../shared/const";
import { AppError } from "../appError";
import { cleanupExpiredUploadTempFiles, registerProjectUploadRoute, uploadTempDir } from "./projectUploadRoute";

let lastTempFilePath: string | null = null;
const outsideTempDir = join(tmpdir(), "legacy-lens-upload-outside");
const { uploadLimiterMock } = vi.hoisted(() => ({
  uploadLimiterMock: vi.fn(async (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock("../_core/sdk", () => ({
  sdk: {
    authenticateRequest: vi.fn(async () => ({ id: 7 })),
  },
}));

vi.mock("../_core/rateLimiter", () => ({
  createRateLimiter: vi.fn(() => uploadLimiterMock),
}));

vi.mock("./projectWorkflow", () => ({
  getActiveImportZipTempFilePaths: vi.fn(async () => new Set<string>()),
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
  await rm(outsideTempDir, { recursive: true, force: true }).catch(() => undefined);
  vi.clearAllMocks();
  uploadLimiterMock.mockImplementation(async (_req: unknown, _res: unknown, next: () => void) => next());
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
      await expect(response.json()).resolves.toMatchObject({
        code: "UNAUTHORIZED",
        error: expect.any(String),
        message: expect.any(String),
      });
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

  it("stores uploads under a generated safe .zip temp file name", async () => {
    await withUploadServer(async (baseUrl) => {
      const formData = new FormData();
      formData.append("file", new Blob(["zip-bytes"], { type: "application/zip" }), "../nested\\evil?.zip");

      const response = await fetch(`${baseUrl}/api/projects/42/upload`, {
        method: "POST",
        body: formData,
      });

      expect(response.status).toBe(200);
    });

    expect(lastTempFilePath).toBeTruthy();
    expect(lastTempFilePath!.startsWith(uploadTempDir)).toBe(true);
    expect(basename(lastTempFilePath!)).toMatch(/^\d+-[0-9a-f-]+\.zip$/i);
    expect(basename(lastTempFilePath!)).not.toContain("evil");
    expect(basename(lastTempFilePath!)).not.toContain("..");
    expect(lastTempFilePath!).not.toContain("../");
    expect(lastTempFilePath!).not.toContain("..\\");
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
      await expect(response.json()).resolves.toMatchObject({
        code: "ZIP_INVALID",
        error: expect.stringContaining("ZIP upload exceeds the raw archive limit"),
      });
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
      await expect(response.json()).resolves.toMatchObject({
        code: "BAD_REQUEST",
        error: "Invalid project id.",
        message: "Invalid project id.",
      });
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
      await expect(response.json()).resolves.toMatchObject({
        code: "BAD_REQUEST",
        error: "Exactly one import source is required.",
        message: "Exactly one import source is required.",
      });
    });

    await expect(listUploadTempFiles()).resolves.toEqual(beforeFiles);
  });

  it("cleans the temp file when job creation fails and returns a 500 response for internal import errors", async () => {
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

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        code: "IMPORT_FAILED",
        error: "Unable to queue import.",
      });
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
      await expect(response.json()).resolves.toMatchObject({
        code: "INVALID_GIT_URL",
        error: "Git URL is not allowed.",
      });
    });
  });

  it("returns 409 when the project already has an active job", async () => {
    const { queueImportProjectZipFromTempFile } = await import("./projectWorkflow");
    vi.mocked(queueImportProjectZipFromTempFile).mockRejectedValueOnce(
      new AppError("PROJECT_JOB_ACTIVE", "Project already has an active job.")
    );

    await withUploadServer(async (baseUrl) => {
      const formData = new FormData();
      formData.append("file", new Blob(["zip-bytes"], { type: "application/zip" }), "project.zip");

      const response = await fetch(`${baseUrl}/api/projects/42/upload`, {
        method: "POST",
        body: formData,
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "PROJECT_JOB_ACTIVE",
        error: "Project already has an active job.",
        message: "Project already has an active job.",
      });
    });
  });

  it("applies the upload rate limiter before multer writes a temp file", async () => {
    const { queueImportProjectZipFromTempFile } = await import("./projectWorkflow");
    const beforeFiles = await listUploadTempFiles();
    uploadLimiterMock.mockImplementationOnce(async (_req: unknown, res: unknown) => {
      const response = res as { status: (code: number) => { json: (payload: unknown) => void } };
      response.status(429).json({
        code: "RATE_LIMITED",
        error: "Too many upload requests, please try again later",
        message: "Too many upload requests, please try again later",
      });
    });

    await withUploadServer(async (baseUrl) => {
      const formData = new FormData();
      formData.append("file", new Blob(["zip-bytes"], { type: "application/zip" }), "project.zip");

      const response = await fetch(`${baseUrl}/api/projects/42/upload`, {
        method: "POST",
        body: formData,
      });

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        code: "RATE_LIMITED",
        error: "Too many upload requests, please try again later",
        message: "Too many upload requests, please try again later",
      });
    });

    expect(vi.mocked(queueImportProjectZipFromTempFile)).not.toHaveBeenCalled();
    await expect(listUploadTempFiles()).resolves.toEqual(beforeFiles);
  });

  it("deletes only expired temp zip files from the upload temp directory", async () => {
    await mkdir(uploadTempDir, { recursive: true });
    const oldZipPath = join(uploadTempDir, "old.zip");
    const freshZipPath = join(uploadTempDir, "fresh.zip");
    const textPath = join(uploadTempDir, "notes.txt");
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date("2026-01-03T00:00:00.000Z");
    await Promise.all([
      writeFile(oldZipPath, "zip"),
      writeFile(freshZipPath, "zip"),
      writeFile(textPath, "note"),
    ]);
    await utimes(oldZipPath, oldDate, oldDate);
    await utimes(freshZipPath, now, now);
    await utimes(textPath, oldDate, oldDate);

    await cleanupExpiredUploadTempFiles(now, 24 * 60 * 60 * 1000);

    await expectFileMissing(oldZipPath);
    await expectFileExists(freshZipPath);
    await expectFileExists(textPath);
  });

  it("keeps expired temp files that are still referenced by queued or running import jobs", async () => {
    const { getActiveImportZipTempFilePaths } = await import("./projectWorkflow");
    await mkdir(uploadTempDir, { recursive: true });
    const activeZipPath = join(uploadTempDir, "active.zip");
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(activeZipPath, "zip");
    await utimes(activeZipPath, oldDate, oldDate);
    vi.mocked(getActiveImportZipTempFilePaths).mockResolvedValueOnce(new Set([activeZipPath]));

    await cleanupExpiredUploadTempFiles(new Date("2026-01-03T00:00:00.000Z"), 24 * 60 * 60 * 1000);

    await expectFileExists(activeZipPath);
  });

  it("removes expired orphan temp zip files after completed or failed jobs release them", async () => {
    const { getActiveImportZipTempFilePaths } = await import("./projectWorkflow");
    await mkdir(uploadTempDir, { recursive: true });
    const orphanZipPath = join(uploadTempDir, "orphan.zip");
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(orphanZipPath, "zip");
    await utimes(orphanZipPath, oldDate, oldDate);
    vi.mocked(getActiveImportZipTempFilePaths).mockResolvedValueOnce(new Set());

    await cleanupExpiredUploadTempFiles(new Date("2026-01-03T00:00:00.000Z"), 24 * 60 * 60 * 1000);

    await expectFileMissing(orphanZipPath);
  });

  it("never deletes files outside the managed upload temp directory", async () => {
    await mkdir(outsideTempDir, { recursive: true });
    const outsideZipPath = join(outsideTempDir, "old.zip");
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(outsideZipPath, "zip");
    await utimes(outsideZipPath, oldDate, oldDate);

    await cleanupExpiredUploadTempFiles(new Date("2026-01-03T00:00:00.000Z"), 24 * 60 * 60 * 1000);

    await expectFileExists(outsideZipPath);
  });

  it("ignores temp cleanup permission errors instead of crashing", async () => {
    await mkdir(uploadTempDir, { recursive: true });
    const oldZipPath = join(uploadTempDir, "locked.zip");
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(oldZipPath, "zip");
    await utimes(oldZipPath, oldDate, oldDate);
    const removeFile = vi.fn(async () => {
      throw new Error("EPERM");
    });

    await expect(
      cleanupExpiredUploadTempFiles(new Date("2026-01-03T00:00:00.000Z"), 24 * 60 * 60 * 1000, removeFile)
    ).resolves.toBeUndefined();

    await expectFileExists(oldZipPath);
    expect(removeFile).toHaveBeenCalledWith(oldZipPath, { force: true });
  });
});
