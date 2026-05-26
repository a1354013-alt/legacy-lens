import type { Express, Request, Response } from "express";
import { AppError } from "../appError";
import { sendAppErrorResponse, sendHttpErrorResponse } from "../httpApiErrors";
import { buildReportArchiveBuffer } from "../services/projectWorkflow";
import { createRateLimiter } from "./rateLimiter";
import { sdk } from "./sdk";

export function registerReportDownloadRoute(app: Express) {
  app.get("/api/projects/:projectId/report.zip", createRateLimiter("heavyRead"), async (req: Request, res: Response) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      sendHttpErrorResponse(res, 400, "BAD_REQUEST", "Project id must be a positive integer.");
      return;
    }

    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user) {
        sendHttpErrorResponse(res, 401, "UNAUTHORIZED", "Invalid session.");
        return;
      }
      const archive = await buildReportArchiveBuffer(projectId, user.id);
      res.setHeader("Content-Type", archive.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${archive.fileName}"`);
      res.setHeader("Content-Length", String(archive.buffer.length));
      res.status(200).send(archive.buffer);
    } catch (error) {
      if (error instanceof AppError) {
        sendAppErrorResponse(
          res,
          error,
          error.code === "REPORT_TOO_LARGE"
            ? {
                remediation:
                  "Try analyzing a smaller project slice, splitting the import, or raising MAX_REPORT_ARCHIVE_BYTES deliberately.",
              }
            : undefined
        );
        return;
      }

      const message = error instanceof Error ? error.message : "Report download failed.";
      sendHttpErrorResponse(res, 500, "INTERNAL_SERVER_ERROR", message);
    }
  });
}
