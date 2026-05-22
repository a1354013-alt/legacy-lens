import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { normalizeJsonArrayField } from "./_core/jsonNormalization";

const DATABASE_URL = process.env.DATABASE_URL;
const migrationDir = path.join(process.cwd(), "drizzle");

function getMigrationFiles() {
  return fs
    .readdirSync(migrationDir)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
}

function splitSqlStatements(sqlText: string) {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function parseConnectionOptions(connectionString: string) {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: Number(url.port || "3306"),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

async function createDatabase(connectionString: string, suffix: string) {
  const admin = await mysql.createConnection(parseConnectionOptions(connectionString));
  const dbName = `legacy_lens_${suffix}_${Date.now()}`;
  await admin.query(`CREATE DATABASE \`${dbName}\``);
  await admin.end();
  return dbName;
}

async function dropDatabase(connectionString: string, dbName: string) {
  const admin = await mysql.createConnection(parseConnectionOptions(connectionString));
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await admin.end();
}

async function connectToDatabase(connectionString: string, dbName: string) {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return mysql.createConnection({
    uri: url.toString(),
    multipleStatements: true,
  });
}

async function applyMigrationFiles(connection: mysql.Connection, files: string[]) {
  for (const file of files) {
    const sqlText = fs.readFileSync(path.join(migrationDir, file), "utf8");
    for (const statement of splitSqlStatements(sqlText)) {
      await connection.query(statement);
    }
  }
}

async function tableExists(connection: mysql.Connection, dbName: string, tableName: string) {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",
    [dbName, tableName]
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

const maybeDescribe = DATABASE_URL ? describe : describe.skip;

maybeDescribe("Drizzle migration smoke", () => {
  it("runs all migrations on a fresh database and creates the latest tables", async () => {
    const dbName = await createDatabase(DATABASE_URL as string, "fresh");
    const connection = await connectToDatabase(DATABASE_URL as string, dbName);

    try {
      await applyMigrationFiles(connection, getMigrationFiles());

      await expect(tableExists(connection, dbName, "projects")).resolves.toBe(true);
      await expect(tableExists(connection, dbName, "files")).resolves.toBe(true);
      await expect(tableExists(connection, dbName, "analysisResults")).resolves.toBe(true);
      await expect(tableExists(connection, dbName, "symbols")).resolves.toBe(true);
      await expect(tableExists(connection, dbName, "dependencies")).resolves.toBe(true);
      await expect(tableExists(connection, dbName, "fields")).resolves.toBe(true);
      await expect(tableExists(connection, dbName, "fieldDependencies")).resolves.toBe(true);
      await expect(tableExists(connection, dbName, "risks")).resolves.toBe(true);
      await expect(tableExists(connection, dbName, "rules")).resolves.toBe(true);
      await expect(tableExists(connection, dbName, "projectJobs")).resolves.toBe(true);

      const [projectColumns] = await connection.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM `projects` LIKE 'lastAnalyzedAt'");
      const [jobColumns] = await connection.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM `projectJobs` LIKE 'finishedAt'");
      const [payloadColumns] = await connection.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM `projectJobs` LIKE 'payloadJson'");
      const [activeKeyColumns] = await connection.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM `projectJobs` LIKE 'activeKey'");

      expect(projectColumns).toHaveLength(1);
      expect(jobColumns).toHaveLength(1);
      expect(payloadColumns).toHaveLength(1);
      expect(activeKeyColumns).toHaveLength(1);
    } finally {
      await connection.end();
      await dropDatabase(DATABASE_URL as string, dbName);
    }
  });

  it("upgrades a pre-0006 schema without breaking legacy data", async () => {
    const dbName = await createDatabase(DATABASE_URL as string, "upgrade");
    const connection = await connectToDatabase(DATABASE_URL as string, dbName);

    try {
      await applyMigrationFiles(connection, getMigrationFiles().slice(0, 6));

      await connection.query(
        "INSERT INTO `users` (`id`, `openId`, `role`) VALUES (1, 'user-1', 'user')"
      );
      await connection.query(
        "INSERT INTO `projects` (`id`, `userId`, `name`, `language`, `sourceType`, `status`, `analysisProgress`, `importProgress`) VALUES (1, 1, 'legacy-project', 'go', 'upload', 'completed', 100, 100)"
      );
      await connection.query(
        "INSERT INTO `files` (`id`, `projectId`, `filePath`, `fileName`, `fileType`, `status`, `content`) VALUES (1, 1, 'main.go', 'main.go', '.go', 'stored', 'package main')"
      );
      await connection.query(
        "INSERT INTO `symbols` (`id`, `projectId`, `fileId`, `name`, `type`, `startLine`, `endLine`) VALUES (1, 1, 1, 'main', 'function', 1, 3), (2, 1, 1, 'repo', 'method', 4, 6)"
      );
      await connection.query(
        "INSERT INTO `dependencies` (`id`, `projectId`, `sourceSymbolId`, `targetSymbolId`, `dependencyType`) VALUES (1, 1, 1, 2, 'calls')"
      );
      await connection.query(
        "INSERT INTO `analysisResults` (`id`, `projectId`, `status`, `flowMarkdown`, `dataDependencyMarkdown`, `risksMarkdown`, `rulesYaml`) VALUES (1, 1, 'completed', '# FLOW', '# DATA', '# RISKS', 'rules: []')"
      );

      await applyMigrationFiles(connection, getMigrationFiles().slice(6));

      const [projectRows] = await connection.query<mysql.RowDataPacket[]>("SELECT `status`, `importWarningsJson` FROM `projects` WHERE `id` = 1");
      const [analysisRows] = await connection.query<mysql.RowDataPacket[]>("SELECT `status`, `warningsJson` FROM `analysisResults` WHERE `id` = 1");
      const [dependencyRows] = await connection.query<mysql.RowDataPacket[]>("SELECT `targetSymbolId`, `targetKind` FROM `dependencies` WHERE `id` = 1");
      const [fileColumns] = await connection.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM `files` LIKE 'content'");
      const [analysisColumns] = await connection.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM `analysisResults` LIKE 'flowMarkdown'");
      const [jobColumns] = await connection.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM `projectJobs` LIKE 'finishedAt'");
      const [activeKeyColumns] = await connection.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM `projectJobs` LIKE 'activeKey'");
      const [projectColumns] = await connection.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM `projects` LIKE 'lastAnalyzedAt'");

      expect(projectRows[0]?.status).toBe("completed");
      expect(projectRows[0]?.importWarningsJson).toBeDefined();
      // Normalize JSON array field: MySQL driver may return parsed [] or string "[]"
      const normalizedProjectWarnings = normalizeJsonArrayField(projectRows[0]?.importWarningsJson);
      expect(normalizedProjectWarnings).toEqual([]);
      
      // Verify analysisResults.warningsJson was also migrated correctly
      expect(analysisRows[0]?.status).toBe("completed");
      const normalizedAnalysisWarnings = normalizeJsonArrayField(analysisRows[0]?.warningsJson);
      expect(normalizedAnalysisWarnings).toEqual([]);
      
      expect(dependencyRows[0]?.targetSymbolId).toBe(2);
      expect(dependencyRows[0]?.targetKind).toBe("internal");
      expect(String(fileColumns[0]?.Type ?? "")).toBe("mediumtext");
      expect(String(analysisColumns[0]?.Type ?? "")).toBe("mediumtext");
      await expect(tableExists(connection, dbName, "projectJobs")).resolves.toBe(true);
      expect(jobColumns).toHaveLength(1);
      expect(activeKeyColumns).toHaveLength(1);
      expect(projectColumns).toHaveLength(1);
    } finally {
      await connection.end();
      await dropDatabase(DATABASE_URL as string, dbName);
    }
  });
});
