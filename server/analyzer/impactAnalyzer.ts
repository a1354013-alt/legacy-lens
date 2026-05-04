import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  dependencies,
  fieldDependencies,
  fields,
  files,
  risks,
  rules,
  symbols,
} from "../../drizzle/schema";
import type { ImpactAnalysisResult, ImpactTargetType } from "../../shared/contracts";
import { getDb } from "../db";

export class ImpactAnalyzer {
  async analyze(projectId: number, target: string, type: ImpactTargetType = "auto"): Promise<ImpactAnalysisResult> {
    const db = await getDb();
    if (!db) {
      throw new Error("Database not available");
    }

    let resolvedType = type;
    let targetId: number | null = null;
    const warnings: string[] = [];

    // 1. Resolve Target Type and ID
    if (type === "auto") {
      // Try symbol
      const [symbolMatch] = await db.select().from(symbols).where(eq(symbols.name, target)).limit(1);
      if (symbolMatch) {
        resolvedType = "symbol";
        targetId = symbolMatch.id;
      } else {
        // Try SQL table
        const [fieldMatch] = await db.select().from(fields).where(eq(fields.tableName, target)).limit(1);
        if (fieldMatch) {
          resolvedType = "sql_table";
        } else {
          // Try file
          const [fileMatch] = await db.select().from(files).where(eq(files.fileName, target)).limit(1);
          if (fileMatch) {
            resolvedType = "file";
            targetId = fileMatch.id;
          } else {
            // Try risk
            const [riskMatch] = await db.select().from(risks).where(eq(risks.title, target)).limit(1);
            if (riskMatch) {
              resolvedType = "risk";
              targetId = riskMatch.id;
            } else {
              // Try rule
              const [ruleMatch] = await db.select().from(rules).where(eq(rules.name, target)).limit(1);
              if (ruleMatch) {
                resolvedType = "rule";
                targetId = ruleMatch.id;
              }
            }
          }
        }
      }
    }

    const result: ImpactAnalysisResult = {
      target,
      targetType: resolvedType,
      confidence: targetId || resolvedType !== "auto" ? 1.0 : 0,
      summary: "",
      affectedFiles: [],
      affectedSymbols: [],
      affectedTables: [],
      affectedFields: [],
      affectedRules: [],
      affectedRisks: [],
      dependencyChains: [],
      warnings: [],
    };

    if (resolvedType === "auto" && !targetId) {
      result.warnings.push(`Could not resolve target type for "${target}"`);
      result.summary = "No impact found as the target could not be identified.";
      return result;
    }

    // 2. Perform Deterministic Analysis based on resolvedType
    const affectedFileSet = new Set<string>();
    const affectedSymbolMap = new Map<string, { name: string; file: string; type: string }>();
    const affectedTableSet = new Set<string>();
    const affectedFieldMap = new Map<string, { table: string; field: string }>();
    const affectedRuleSet = new Set<string>();
    const affectedRiskSet = new Set<string>();

    if (resolvedType === "symbol" || type === "symbol") {
      const targetSymbols = await db.select().from(symbols).where(eq(symbols.name, target)).execute();
      for (const sym of targetSymbols) {
        // Dependencies (who calls this symbol)
        const callers = await db
          .select({
            callerId: dependencies.sourceSymbolId,
            callerName: symbols.name,
            callerFile: files.filePath,
            callerType: symbols.type,
          })
          .from(dependencies)
          .innerJoin(symbols, eq(dependencies.sourceSymbolId, symbols.id))
          .innerJoin(files, eq(symbols.fileId, files.id))
          .where(eq(dependencies.targetSymbolId, sym.id))
          .execute();

        for (const caller of callers) {
          affectedFileSet.add(caller.callerFile);
          affectedSymbolMap.set(`${caller.callerFile}:${caller.callerName}`, {
            name: caller.callerName,
            file: caller.callerFile,
            type: caller.callerType,
          });
          result.dependencyChains.push([caller.callerName, sym.name]);
        }

        // Fields used by this symbol
        const relatedFields = await db
          .select({
            tableName: fields.tableName,
            fieldName: fields.fieldName,
          })
          .from(fieldDependencies)
          .innerJoin(fields, eq(fieldDependencies.fieldId, fields.id))
          .where(eq(fieldDependencies.symbolId, sym.id))
          .execute();

        for (const f of relatedFields) {
          affectedTableSet.add(f.tableName);
          affectedFieldMap.set(`${f.tableName}.${f.fieldName}`, {
            table: f.tableName,
            field: f.fieldName,
          });
        }
      }
    } else if (resolvedType === "sql_table" || resolvedType === "sql_field") {
      let fieldQuery = db.select().from(fields);
      if (resolvedType === "sql_table") {
        fieldQuery = fieldQuery.where(eq(fields.tableName, target)) as any;
      } else {
        const [table, field] = target.split(".");
        if (field) {
          fieldQuery = fieldQuery.where(and(eq(fields.tableName, table), eq(fields.fieldName, field))) as any;
        } else {
          fieldQuery = fieldQuery.where(eq(fields.fieldName, target)) as any;
        }
      }

      const targetFields = await fieldQuery;
      if (targetFields.length > 0) {
        const fieldIds = targetFields.map((f) => f.id);
        const usages = await db
          .select({
            symbolName: symbols.name,
            symbolFile: files.filePath,
            symbolType: symbols.type,
            tableName: fields.tableName,
            fieldName: fields.fieldName,
          })
          .from(fieldDependencies)
          .innerJoin(symbols, eq(fieldDependencies.symbolId, symbols.id))
          .innerJoin(files, eq(symbols.fileId, files.id))
          .innerJoin(fields, eq(fieldDependencies.fieldId, fields.id))
          .where(inArray(fieldDependencies.fieldId, fieldIds))
          .execute();

        for (const usage of usages) {
          affectedFileSet.add(usage.symbolFile);
          affectedSymbolMap.set(`${usage.symbolFile}:${usage.symbolName}`, {
            name: usage.symbolName,
            file: usage.symbolFile,
            type: usage.symbolType,
          });
          affectedTableSet.add(usage.tableName);
          affectedFieldMap.set(`${usage.tableName}.${usage.fieldName}`, {
            table: usage.tableName,
            field: usage.fieldName,
          });
          result.dependencyChains.push([usage.symbolName, `${usage.tableName}.${usage.fieldName}`]);
        }
      }
    } else if (resolvedType === "risk") {
      const targetRisks = await db.select().from(risks).where(eq(risks.title, target)).execute();
      for (const risk of targetRisks) {
        if (risk.sourceFile) {
          affectedFileSet.add(risk.sourceFile);
          // Find symbols in that file at that line
          const [relatedSymbol] = await db
            .select({ name: symbols.name, type: symbols.type })
            .from(symbols)
            .innerJoin(files, eq(symbols.fileId, files.id))
            .where(
              and(
                eq(files.filePath, risk.sourceFile),
                lte(symbols.startLine, risk.lineNumber || 0),
                gte(symbols.endLine, risk.lineNumber || 0)
              )
            )
            .limit(1);
          if (relatedSymbol) {
            affectedSymbolMap.set(`${risk.sourceFile}:${relatedSymbol.name}`, {
              name: relatedSymbol.name,
              file: risk.sourceFile,
              type: relatedSymbol.type,
            });
          }
        }
      }
    }

    // Populate result arrays
    result.affectedFiles = Array.from(affectedFileSet);
    result.affectedSymbols = Array.from(affectedSymbolMap.values());
    result.affectedTables = Array.from(affectedTableSet);
    result.affectedFields = Array.from(affectedFieldMap.values());
    result.affectedRules = Array.from(affectedRuleSet);
    result.affectedRisks = Array.from(affectedRiskSet);

    // Summary generation
    const impactCount =
      result.affectedFiles.length +
      result.affectedSymbols.length +
      result.affectedTables.length +
      result.affectedFields.length;
    result.summary = `Modifying ${target} (${resolvedType}) affects ${impactCount} components across ${result.affectedFiles.length} files.`;

    return result;
  }
}


