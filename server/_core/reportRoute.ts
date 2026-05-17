import type { Express, Request, Response } from "express";
import { AppError } from "../appError";
import { buildReportArchiveBuffer } from "../services/projectWorkflow";
import { sdk } from "./sdk";

function sendAppError(res: Response, error: AppError) {
  const status = error.code === "PROJECT_NOT_FOUND" ? 404 : error.code === "REPORT_NOT_READY" ? 409 : 400;
  res.status(status).json({ error: error.message, code: error.code });
}

export function registerReportDownloadRoute(app: Express) {
  app.get("/api/projects/:projectId/report.zip", async (req: Request, res: Response) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      res.status(400).json({ error: "Project id must be a positive integer.", code: "INVALID_PROJECT_STATE" });
      return;
    }

    try {
      const user = await sdk.authenticateRequest(req);
      const archive = await buildReportArchiveBuffer(projectId, user.id);
      res.setHeader("Content-Type", archive.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${archive.fileName}"`);
      res.setHeader("Content-Length", String(archive.buffer.length));
      res.status(200).send(archive.buffer);
    } catch (error) {
      if (error instanceof AppError) {
        sendAppError(res, error);
        return;
      }

      const message = error instanceof Error ? error.message : "Report download failed.";
      const status = message.toLowerCase().includes("session") || message.toLowerCase().includes("auth") ? 401 : 500;
      res.status(status).json({ error: message });
    }
  });
}
