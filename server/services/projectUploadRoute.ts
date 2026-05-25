import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ZIP_RAW_BYTES, UNAUTHED_ERR_MSG } from "@shared/const";
import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../appError";
import { sdk } from "../_core/sdk";
import { logger } from "../_core/logger";
import { queueImportProjectGit, queueImportProjectZipFromTempFile } from "./projectWorkflow";

const uploadTempDir = join(tmpdir(), "legacy-lens-upload");

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      void mkdir(uploadTempDir, { recursive: true })
        .then(() => callback(null, uploadTempDir))
        .catch((error) => callback(error as Error, uploadTempDir));
    },
    filename: (_req, file, callback) => {
      callback(null, `${Date.now()}-${randomUUID()}-${file.originalname}`);
    },
  }),
  limits: {
    fileSize: MAX_ZIP_RAW_BYTES,
    files: 1,
  },
});

async function requireAuthenticatedUser(req: Request, res: Response) {
  try {
    return await sdk.authenticateRequest(req);
  } catch {
    res.status(401).send(UNAUTHED_ERR_MSG);
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
  app.post("/api/projects/:projectId/upload", authenticateProjectUploadRequest, async (req, res) => {
    try {
      await runSingleFileUpload(req, res);
    } catch (error) {
      await cleanupUploadedFile(req.file);

      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        res.status(413).send(`ZIP upload exceeds the raw archive limit (${MAX_ZIP_RAW_BYTES} bytes).`);
        return;
      }

      if (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).send(message);
        return;
      }
    }

    const user = res.locals.user as { id: number } | undefined;
    if (!user) {
      await cleanupUploadedFile(req.file);
      res.status(401).send(UNAUTHED_ERR_MSG);
      return;
    }

    const file = req.file;

    try {
      const projectId = Number(req.params.projectId);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        await cleanupUploadedFile(file);
        res.status(400).send("Invalid project id.");
        return;
      }

      const gitUrl = typeof req.body.gitUrl === "string" ? req.body.gitUrl.trim() : "";

      if ((file ? 1 : 0) + (gitUrl ? 1 : 0) !== 1) {
        await cleanupUploadedFile(file);
        res.status(400).send("Exactly one import source is required.");
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
      res.status(400).send(errorToSend);
    }
  });
}
