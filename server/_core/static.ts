import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { logger } from "./logger";

function getStaticDistPath(nodeEnv = process.env.NODE_ENV) {
  return nodeEnv === "production"
    ? path.resolve(import.meta.dirname, "public")
    : path.resolve(import.meta.dirname, "../..", "dist", "public");
}

function assertProductionStaticAssets(distPath: string, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== "production") {
    return;
  }

  const indexPath = path.resolve(distPath, "index.html");
  if (fs.existsSync(distPath) && fs.existsSync(indexPath)) {
    return;
  }

  const error = new Error(
    `Missing production static build output. Expected "${distPath}" and "${indexPath}". Run "pnpm build" before starting the production server.`
  );

  logger.error("Missing production static build output", {
    action: "static.serve",
    status: "error",
    distPath,
    indexPath,
    nodeEnv,
  });

  throw error;
}

export function serveStatic(app: Express) {
  const distPath = getStaticDistPath();
  assertProductionStaticAssets(distPath);

  app.use(express.static(distPath));

  // Fall through to index.html if the file doesn't exist.
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

export { assertProductionStaticAssets, getStaticDistPath };
