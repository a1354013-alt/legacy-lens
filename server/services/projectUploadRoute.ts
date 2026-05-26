import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ZIP_RAW_BYTES, UNAUTHED_ERR_MSG } from "@shared/const";
import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../appError";
import { sendAppErrorResponse, sendHttpErrorResponse } from "../httpApiErrors";
import { sdk } from "../_core/sdk";
import { logger } from "../_core/logger";
import { createRateLimiter } from "../_core/rateLimiter";
import { getActiveImportZipTempFilePaths, queueImportProjectGit, queueImportProjectZipFromTempFile } from "./projectWorkflow";

export const uploadTempDir = join(tmpdir(), "legacy-lens-upload");
export const UPLOAD_TEMP_ZIP_TTL_MS = Number.parseInt(process.env.UPLOAD_TEMP_ZIP_TTL_MS ?? "86400000", 10);

function buildSafeUploadTempFileName() {
  return `${Date.now()}-${randomUUID()}.zip`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      void mkdir(uploadTempDir, { recursive: true })
        .then(() => callback(null, uploadTempDir))
        .catch((error) => callback(error as Error, uploadTempDir));
    },
    filename: (_req, _file, callback) => {
      callback(null, buildSafeUploadTempFileName());
    },
  }),
  limits: {
    fileSize: MAX_ZIP_RAW_BYTES,
    files: 1,
  },
});
const uploadRateLimiter = createRateLimiter("upload");

export async function cleanupExpiredUploadTempFiles(
  now = new Date(),
  ttlMs = UPLOAD_TEMP_ZIP_TTL_MS,
  removeFile: (filePath: string, options: { force: true }) => Promise<void> = rm
) {
  await mkdir(uploadTempDir, { recursive: true });
  const expiresBefore = now.getTime() - ttlMs;
  const activeTempPaths = await getActiveImportZipTempFilePaths().catch(() => new Set<string>());
  const entries = await readdir(uploadTempDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) {
      continue;
    }

    const filePath = join(uploadTempDir, entry.name);

    try {
      const fileStats = await stat(filePath);
      if (fileStats.mtimeMs > expiresBefore) {
        continue;
      }

      if (activeTempPaths.has(filePath)) {
        continue;
      }

      await removeFile(filePath, { force: true });
    } catch (error) {
      logger.warn("Upload temp file cleanup skipped an entry", {
        action: "project.upload.temp.cleanup",
        status: "error",
        filePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function requireAuthenticatedUser(req: Request, res: Response) {
  try {
    return await sdk.authenticateRequest(req);
  } catch {
    sendHttpErrorResponse(res, 401, "UNAUTHORIZED", UNAUTHED_ERR_MSG);
    return null;
  }
}

async function cleanupUploadedFile(file?: Express.Multer.File | null) {
  if (!file?.path) {
    return;
  }

  await rm(file.path, { force: true }).catch(() => undefined);
}

async function runSingleFileUpload(req: Request, res: Response) {
  await new Promise<void>((resolve, reject) => {
    upload.single("file")(req, res, (error: unknown) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function authenticateProjectUploadRequest(req: Request, res: Response, next: NextFunction) {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) {
    return;
  }

  res.locals.user = user;
  next();
}

export function registerProjectUploadRoute(app: Express) {
  void cleanupExpiredUploadTempFiles().catch((error) => {
    logger.warn("Upload temp file cleanup failed during startup", {
      action: "project.upload.temp.cleanup.startup",
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });

  app.post("/api/projects/:projectId/upload", authenticateProjectUploadRequest, uploadRateLimiter, async (req, res) => {
    try {
      await runSingleFileUpload(req, res);
    } catch (error) {
      await cleanupUploadedFile(req.file);

      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        sendHttpErrorResponse(res, 413, "ZIP_INVALID", `ZIP upload exceeds the raw archive limit (${MAX_ZIP_RAW_BYTES} bytes).`);
        return;
      }

      if (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendHttpErrorResponse(res, 400, "BAD_REQUEST", message);
        return;
      }
    }

    const user = res.locals.user as { id: number } | undefined;
    if (!user) {
      await cleanupUploadedFile(req.file);
      sendHttpErrorResponse(res, 401, "UNAUTHORIZED", UNAUTHED_ERR_MSG);
      return;
    }

    const file = req.file;

    try {
      const projectId = Number(req.params.projectId);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        await cleanupUploadedFile(file);
        sendHttpErrorResponse(res, 400, "BAD_REQUEST", "Invalid project id.");
        return;
      }

      const gitUrl = typeof req.body.gitUrl === "string" ? req.body.gitUrl.trim() : "";

      if ((file ? 1 : 0) + (gitUrl ? 1 : 0) !== 1) {
        await cleanupUploadedFile(file);
        sendHttpErrorResponse(res, 400, "BAD_REQUEST", "Exactly one import source is required.");
        return;
      }

      if (file) {
        const job = await queueImportProjectZipFromTempFile(projectId, user.id, file.path, file.originalname);
        res.json({ jobId: job.jobId, jobType: "import_zip" as const });
        return;
      }

      const job = await queueImportProjectGit(projectId, user.id, gitUrl);
      res.json({ jobId: job.jobId, jobType: "import_git" as const });
    } catch (caughtError) {
      await cleanupUploadedFile(file);
      const projectId = Number(req.params.projectId);
      const errorToSend =
        caughtError instanceof AppError ? caughtError.message : caughtError instanceof Error ? caughtError.message : String(caughtError);
      logger.warn("Project upload route failed", {
        action: "project.upload.route",
        status: "error",
        projectId: Number.isInteger(projectId) ? projectId : null,
        message: errorToSend,
      });
      if (caughtError instanceof AppError) {
        sendAppErrorResponse(res, caughtError);
        return;
      }
      sendHttpErrorResponse(res, 500, "INTERNAL_SERVER_ERROR", errorToSend);
    }
  });
}
