import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ZIP_RAW_BYTES, UNAUTHED_ERR_MSG } from "@shared/const";
import type { Express, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../appError";
import { sdk } from "../_core/sdk";
import { logger } from "../_core/logger";
import { queueImportProjectGit, queueImportProjectZipFromTempFile } from "./projectWorkflow";

const uploadTempDir = join(tmpdir(), "legacy-lens-upload");

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadTempDir,
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

export function registerProjectUploadRoute(app: Express) {
  app.post("/api/projects/:projectId/upload", (req, res) => {
    upload.single("file")(req, res, async (error) => {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        res.status(413).send(`ZIP upload exceeds the raw archive limit (${MAX_ZIP_RAW_BYTES} bytes).`);
        return;
      }

      if (error) {
        res.status(400).send(error.message);
        return;
      }

      const user = await requireAuthenticatedUser(req, res);
      if (!user) {
        return;
      }

      const projectId = Number(req.params.projectId);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        res.status(400).send("Invalid project id.");
        return;
      }

      const file = req.file;
      const gitUrl = typeof req.body.gitUrl === "string" ? req.body.gitUrl.trim() : "";

      if ((file ? 1 : 0) + (gitUrl ? 1 : 0) !== 1) {
        res.status(400).send("Exactly one import source is required.");
        return;
      }

      try {
        if (file) {
          const job = await queueImportProjectZipFromTempFile(projectId, user.id, file.path, file.originalname);
          res.json({ jobId: job.jobId, jobType: "import_zip" as const });
          return;
        }

        const job = await queueImportProjectGit(projectId, user.id, gitUrl);
        res.json({ jobId: job.jobId, jobType: "import_git" as const });
      } catch (caughtError) {
        if (file?.path) {
          await rm(file.path, { force: true }).catch(() => undefined);
        }
        const errorToSend =
          caughtError instanceof AppError ? caughtError.message : caughtError instanceof Error ? caughtError.message : String(caughtError);
        logger.warn("Project upload route failed", {
          action: "project.upload.route",
          status: "error",
          projectId,
          message: errorToSend,
        });
        res.status(400).send(errorToSend);
      }
    });
  });
}
