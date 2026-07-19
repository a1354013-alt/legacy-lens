import type { Express, Request, Response } from "express";
import { AppError } from "../appError";
import { sendAppErrorResponse, sendHttpErrorResponse } from "../httpApiErrors";
import { buildAnalysisDiffArchiveBuffer, buildReportArchiveBuffer } from "../services/projectWorkflow";
import { createRateLimiter } from "./rateLimiter";
import { sdk } from "./sdk";

export function registerReportDownloadRoute(app: Express) {
  app.get("/api/projects/:projectId/report.zip", createRateLimiter("heavyRead"), async (req: Request, res: Response) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      sendHttpErrorResponse(res, 400, "BAD_REQUEST", "Project id must be a positive integer.");
      return;
    }
    const runIdValue = typeof req.query.runId === "string" ? Number(req.query.runId) : undefined;
    if (req.query.runId !== undefined && (!Number.isInteger(runIdValue) || Number(runIdValue) <= 0)) {
      sendHttpErrorResponse(res, 400, "BAD_REQUEST", "Run id must be a positive integer.");
      return;
    }

    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user) {
        sendHttpErrorResponse(res, 401, "UNAUTHORIZED", "Invalid session.");
        return;
      }
      const archive = await buildReportArchiveBuffer(projectId, user.id, runIdValue);
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

  app.get("/api/projects/:projectId/analysis-diff.zip", createRateLimiter("heavyRead"), async (req: Request, res: Response) => {
    const projectId = Number(req.params.projectId);
    const baseRunId = typeof req.query.baseRunId === "string" ? Number(req.query.baseRunId) : NaN;
    const compareRunId = typeof req.query.compareRunId === "string" ? Number(req.query.compareRunId) : NaN;
    if (!Number.isInteger(projectId) || projectId <= 0) {
      sendHttpErrorResponse(res, 400, "BAD_REQUEST", "Project id must be a positive integer.");
      return;
    }
    if (!Number.isInteger(baseRunId) || baseRunId <= 0 || !Number.isInteger(compareRunId) || compareRunId <= 0) {
      sendHttpErrorResponse(res, 400, "BAD_REQUEST", "baseRunId and compareRunId must be positive integers.");
      return;
    }

    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user) {
        sendHttpErrorResponse(res, 401, "UNAUTHORIZED", "Invalid session.");
        return;
      }
      const archive = await buildAnalysisDiffArchiveBuffer(projectId, user.id, baseRunId, compareRunId);
      res.setHeader("Content-Type", archive.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${archive.fileName}"`);
      res.setHeader("Content-Length", String(archive.buffer.length));
      res.status(200).send(archive.buffer);
    } catch (error) {
      if (error instanceof AppError) {
        sendAppErrorResponse(res, error);
        return;
      }

      const message = error instanceof Error ? error.message : "Analysis diff download failed.";
      sendHttpErrorResponse(res, 500, "INTERNAL_SERVER_ERROR", message);
    }
  });
}
