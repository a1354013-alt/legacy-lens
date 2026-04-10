import { relations } from "drizzle-orm";
import {
  analysisResults,
  dependencies,
  fieldDependencies,
  fields,
  files,
  projects,
  risks,
  rules,
  symbols,
  users,
} from "./schema";

export const usersRelations = relations(users, ({ many }) => ({
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, {
    fields: [projects.userId],
    references: [users.id],
  }),
  files: many(files),
  symbols: many(symbols),
  dependencies: many(dependencies),
  fields: many(fields),
  fieldDependencies: many(fieldDependencies),
  risks: many(risks),
  rules: many(rules),
  analysisResults: many(analysisResults),
}));

export const filesRelations = relations(files, ({ one, many }) => ({
  project: one(projects, {
    fields: [files.projectId],
    references: [projects.id],
  }),
  symbols: many(symbols),
}));

export const symbolsRelations = relations(symbols, ({ one, many }) => ({
  project: one(projects, {
    fields: [symbols.projectId],
    references: [projects.id],
  }),
  file: one(files, {
    fields: [symbols.fileId],
    references: [files.id],
  }),
  outgoingDependencies: many(dependencies, {
    relationName: "dependency_source_symbol",
  }),
  incomingDependencies: many(dependencies, {
    relationName: "dependency_target_symbol",
  }),
  fieldDependencies: many(fieldDependencies),
}));

export const dependenciesRelations = relations(dependencies, ({ one }) => ({
  project: one(projects, {
    fields: [dependencies.projectId],
    references: [projects.id],
  }),
  sourceSymbol: one(symbols, {
    fields: [dependencies.sourceSymbolId],
    references: [symbols.id],
    relationName: "dependency_source_symbol",
  }),
  targetSymbol: one(symbols, {
    fields: [dependencies.targetSymbolId],
    references: [symbols.id],
    relationName: "dependency_target_symbol",
  }),
}));

export const fieldsRelations = relations(fields, ({ one, many }) => ({
  project: one(projects, {
    fields: [fields.projectId],
    references: [projects.id],
  }),
  fieldDependencies: many(fieldDependencies),
}));

export const fieldDependenciesRelations = relations(fieldDependencies, ({ one }) => ({
  project: one(projects, {
    fields: [fieldDependencies.projectId],
    references: [projects.id],
  }),
  field: one(fields, {
    fields: [fieldDependencies.fieldId],
    references: [fields.id],
  }),
  symbol: one(symbols, {
    fields: [fieldDependencies.symbolId],
    references: [symbols.id],
  }),
}));

export const risksRelations = relations(risks, ({ one }) => ({
  project: one(projects, {
    fields: [risks.projectId],
    references: [projects.id],
  }),
}));

export const rulesRelations = relations(rules, ({ one }) => ({
  project: one(projects, {
    fields: [rules.projectId],
    references: [projects.id],
  }),
}));

export const analysisResultsRelations = relations(analysisResults, ({ one }) => ({
  project: one(projects, {
    fields: [analysisResults.projectId],
    references: [projects.id],
  }),
}));
