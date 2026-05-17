import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { logger } from "./logger";

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    logger.error("Missing client build output directory", {
      action: "static.serve",
      status: "error",
      distPath,
    });
  }

  app.use(express.static(distPath));

  // Fall through to index.html if the file doesn't exist.
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
