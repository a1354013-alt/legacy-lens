import type { analysisResults, dependencies, fieldDependencies, fields, files, projectJobs, projects, risks, rules, symbols, users } from "../drizzle/schema";
import type { getDb } from "./db";

export type UserRecord = typeof users.$inferSelect;
export type InsertUserRecord = typeof users.$inferInsert;

export type ProjectRecord = typeof projects.$inferSelect;
export type InsertProjectRecord = typeof projects.$inferInsert;
export type FileRecord = typeof files.$inferSelect;
export type SymbolRecord = typeof symbols.$inferSelect;
export type DependencyRecord = typeof dependencies.$inferSelect;
export type FieldRecord = typeof fields.$inferSelect;
export type FieldDependencyRecord = typeof fieldDependencies.$inferSelect;
export type RiskRecord = typeof risks.$inferSelect;
export type RuleRecord = typeof rules.$inferSelect;
export type AnalysisResultRecord = typeof analysisResults.$inferSelect;
export type ProjectJobRecord = typeof projectJobs.$inferSelect;

export type DatabaseClient = NonNullable<Awaited<ReturnType<typeof getDb>>>;
