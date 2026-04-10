import type { AnalysisMetrics, AnalysisWarning } from "../shared/contracts";
import { analysisStatuses, fileStatuses, projectLanguages, projectSourceTypes, projectStatuses } from "../shared/contracts";
import { index, int, json, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
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

export const projects = mysqlTable(
  "projects",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    language: mysqlEnum("language", projectLanguages).notNull(),
    sourceType: mysqlEnum("sourceType", projectSourceTypes).notNull(),
    sourceUrl: text("sourceUrl"),
    status: mysqlEnum("status", projectStatuses).default("draft").notNull(),
    importProgress: int("importProgress").default(0).notNull(),
    analysisProgress: int("analysisProgress").default(0).notNull(),
    errorMessage: text("errorMessage"),
    lastErrorCode: varchar("lastErrorCode", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("projects_userId_idx").on(table.userId),
  })
);

export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

export const files = mysqlTable(
  "files",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    filePath: varchar("filePath", { length: 512 }).notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    fileType: varchar("fileType", { length: 50 }),
    status: mysqlEnum("status", fileStatuses).default("stored").notNull(),
    content: text("content"),
    lineCount: int("lineCount"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("files_projectId_idx").on(table.projectId),
  })
);

export type File = typeof files.$inferSelect;
export type InsertFile = typeof files.$inferInsert;

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
    signature: text("signature"),
    description: text("description"),
    metadata: json("metadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("symbols_projectId_idx").on(table.projectId),
    fileIdIdx: index("symbols_fileId_idx").on(table.fileId),
  })
);

export type Symbol = typeof symbols.$inferSelect;
export type InsertSymbol = typeof symbols.$inferInsert;

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

export const fieldDependencies = mysqlTable(
  "fieldDependencies",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    fieldId: int("fieldId").notNull(),
    symbolId: int("symbolId").notNull(),
    operationType: mysqlEnum("operationType", ["read", "write", "calculate"]).notNull(),
    lineNumber: int("lineNumber"),
    context: text("context"),
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

export const rules = mysqlTable(
  "rules",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    ruleType: mysqlEnum("ruleType", ["validation", "format", "magic_value", "calculation"]).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    condition: text("condition"),
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

export const analysisResults = mysqlTable(
  "analysisResults",
  {
    id: int("id").autoincrement().primaryKey(),
    projectId: int("projectId").notNull(),
    status: mysqlEnum("status", analysisStatuses).default("pending").notNull(),
    flowMarkdown: text("flowMarkdown"),
    dataDependencyMarkdown: text("dataDependencyMarkdown"),
    risksMarkdown: text("risksMarkdown"),
    rulesYaml: text("rulesYaml"),
    summaryJson: json("summaryJson").$type<AnalysisMetrics | null>(),
    warningsJson: json("warningsJson").$type<AnalysisWarning[]>().default([]).notNull(),
    errorMessage: text("errorMessage"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    projectIdIdx: index("analysisResults_projectId_idx").on(table.projectId),
    projectIdUniqueIdx: uniqueIndex("analysisResults_projectId_unique").on(table.projectId),
  })
);

export type AnalysisResult = typeof analysisResults.$inferSelect;
export type InsertAnalysisResult = typeof analysisResults.$inferInsert;
