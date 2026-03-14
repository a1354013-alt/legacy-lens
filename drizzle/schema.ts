import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, json, boolean, index } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ============================================================================
// Legacy Lens: 程式碼考古與規則文件生成器 - Core Tables
// ============================================================================

/**
 * 專案表：儲存已匯入的程式碼專案
 */
export const projects = mysqlTable(
  "projects",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    language: mysqlEnum("language", ["go", "delphi", "sql"]).notNull(),
    sourceType: mysqlEnum("sourceType", ["upload", "git"]).notNull(),
    sourceUrl: text("sourceUrl"), // Git URL or local path
    status: mysqlEnum("status", ["pending", "analyzing", "completed", "failed"]).default("pending"),
    analysisProgress: int("analysisProgress").default(0), // 0-100
    errorMessage: text("errorMessage"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("projects_userId_idx").on(table.userId),
  })
);

export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

/**
 * 檔案表：儲存專案中的原始檔案資訊
 */
export const files = mysqlTable(
  "files",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    filePath: varchar("filePath", { length: 512 }).notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    fileType: varchar("fileType", { length: 50 }), // .go, .sql, .pas, etc.
    content: text("content"), // 原始程式碼內容
    lineCount: int("lineCount"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("files_projectId_idx").on(table.projectId),
  })
);

export type File = typeof files.$inferSelect;
export type InsertFile = typeof files.$inferInsert;

/**
 * 符號表：儲存解析出的 function、procedure、method 等符號
 */
export const symbols = mysqlTable(
  "symbols",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    fileId: int("fileId").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    type: mysqlEnum("type", ["function", "procedure", "method", "query", "table"]).notNull(),
    startLine: int("startLine").notNull(),
    endLine: int("endLine").notNull(),
    signature: text("signature"), // 函數簽名
    description: text("description"),
    metadata: json("metadata"), // 額外的 JSON 資訊
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("symbols_projectId_idx").on(table.projectId),
    fileIdIdx: index("symbols_fileId_idx").on(table.fileId),
  })
);

export type Symbol = typeof symbols.$inferSelect;
export type InsertSymbol = typeof symbols.$inferInsert;

/**
 * 依賴關係表：儲存符號之間的呼叫關係（Call Graph）
 */
export const dependencies = mysqlTable(
  "dependencies",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    sourceSymbolId: int("sourceSymbolId").notNull(),
    targetSymbolId: int("targetSymbolId").notNull(),
    dependencyType: mysqlEnum("dependencyType", ["calls", "reads", "writes", "references"]).notNull(),
    lineNumber: int("lineNumber"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("dependencies_projectId_idx").on(table.projectId),
    sourceIdx: index("dependencies_sourceSymbolId_idx").on(table.sourceSymbolId),
    targetIdx: index("dependencies_targetSymbolId_idx").on(table.targetSymbolId),
  })
);

export type Dependency = typeof dependencies.$inferSelect;
export type InsertDependency = typeof dependencies.$inferInsert;

/**
 * 欄位表：儲存資料庫欄位資訊
 */
export const fields = mysqlTable(
  "fields",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    tableName: varchar("tableName", { length: 255 }).notNull(),
    fieldName: varchar("fieldName", { length: 255 }).notNull(),
    fieldType: varchar("fieldType", { length: 100 }),
    description: text("description"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("fields_projectId_idx").on(table.projectId),
  })
);

export type Field = typeof fields.$inferSelect;
export type InsertField = typeof fields.$inferInsert;

/**
 * 欄位依賴表：儲存欄位的讀/寫/計算關係
 */
export const fieldDependencies = mysqlTable(
  "fieldDependencies",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    fieldId: int("fieldId").notNull(),
    symbolId: int("symbolId").notNull(),
    operationType: mysqlEnum("operationType", ["read", "write", "calculate"]).notNull(),
    lineNumber: int("lineNumber"),
    context: text("context"), // 程式碼片段
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("fieldDependencies_projectId_idx").on(table.projectId),
    fieldIdIdx: index("fieldDependencies_fieldId_idx").on(table.fieldId),
    symbolIdIdx: index("fieldDependencies_symbolId_idx").on(table.symbolId),
  })
);

export type FieldDependency = typeof fieldDependencies.$inferSelect;
export type InsertFieldDependency = typeof fieldDependencies.$inferInsert;

/**
 * 風險表：儲存檢測到的風險項目
 */
export const risks = mysqlTable(
  "risks",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    riskType: mysqlEnum("riskType", [
      "magic_value",
      "multiple_writes",
      "missing_condition",
      "format_conversion",
      "inconsistent_logic",
      "other",
    ]).notNull(),
    severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    sourceFile: varchar("sourceFile", { length: 512 }),
    lineNumber: int("lineNumber"),
    codeSnippet: text("codeSnippet"),
    recommendation: text("recommendation"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("risks_projectId_idx").on(table.projectId),
  })
);

export type Risk = typeof risks.$inferSelect;
export type InsertRisk = typeof risks.$inferInsert;

/**
 * 規則表：儲存從程式碼中抽取的規則
 */
export const rules = mysqlTable(
  "rules",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    ruleType: mysqlEnum("ruleType", ["validation", "format", "magic_value", "calculation"]).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    condition: text("condition"), // 規則條件（YAML 或 JSON）
    sourceFile: varchar("sourceFile", { length: 512 }),
    lineNumber: int("lineNumber"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("rules_projectId_idx").on(table.projectId),
  })
);

export type Rule = typeof rules.$inferSelect;
export type InsertRule = typeof rules.$inferInsert;

/**
 * 分析結果表：儲存生成的文件與分析結果
 */
export const analysisResults = mysqlTable(
  "analysisResults",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    flowMarkdown: text("flowMarkdown"), // FLOW.md 內容
    dataDependencyMarkdown: text("dataDependencyMarkdown"), // DATA_DEPENDENCY.md 內容
    risksMarkdown: text("risksMarkdown"), // RISKS.md 內容
    rulesYaml: text("rulesYaml"), // RULES.yaml 內容
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("analysisResults_projectId_idx").on(table.projectId),
  })
);

export type AnalysisResult = typeof analysisResults.$inferSelect;
export type InsertAnalysisResult = typeof analysisResults.$inferInsert;