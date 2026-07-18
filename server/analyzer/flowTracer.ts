import type { DelphiFlowTrace, DelphiFlowTraceRunSummary, SqlStatementEvidence } from "../../shared/contracts";
import { formatDelphiResolverCandidates, resolveDelphiSymbol } from "./delphiSymbolResolver";
import type { DelphiDataBinding, DelphiEventMapEntry, SymbolDependency, AnalyzedSymbol } from "./types";

export const FLOW_TRACE_LIMITS = {
  maxCallDepth: 8,
  maxStepsPerTrace: 200,
  maxTracesPerRun: 2_000,
} as const;

function stablePart(value: string | null | undefined) {
  return (value ?? "unknown").replace(/[^\w.-]+/g, "_");
}

function confidenceForWarnings(warnings: string[]) {
  if (warnings.length >= 2) return "low" as const;
  if (warnings.length === 1) return "medium" as const;
  return "high" as const;
}

function baseNameWithoutExtension(path: string | null | undefined) {
  return (path ?? "").replace(/\\/g, "/").split("/").at(-1)?.replace(/\.[^.]+$/, "").toLowerCase() ?? "";
}

function sortedUniqueWarnings(warnings: string[]) {
  return Array.from(new Set(warnings)).sort((left, right) => left.localeCompare(right));
}

function ownerName(symbol: AnalyzedSymbol | null) {
  if (!symbol?.qualifiedName || !symbol.qualifiedName.includes(".")) return null;
  return symbol.qualifiedName.split(".").slice(0, -1).join(".");
}

export function buildDelphiFlowTraces(input: {
  delphiEventMap: DelphiEventMapEntry[];
  delphiDataBindings: DelphiDataBinding[];
  symbols: AnalyzedSymbol[];
  dependencies: SymbolDependency[];
  sqlStatements: SqlStatementEvidence[];
}): { traces: DelphiFlowTrace[]; summary: DelphiFlowTraceRunSummary } {
  const callsBySource = new Map<string, SymbolDependency[]>();
  for (const dependency of input.dependencies) {
    if (dependency.type !== "calls") continue;
    const bucket = callsBySource.get(dependency.from) ?? [];
    bucket.push(dependency);
    callsBySource.set(dependency.from, bucket);
  }

  const sqlByOwner = new Map<string, SqlStatementEvidence[]>();
  for (const statement of input.sqlStatements) {
    if (!statement.ownerSymbolStableKey) continue;
    const bucket = sqlByOwner.get(statement.ownerSymbolStableKey) ?? [];
    bucket.push(statement);
    sqlByOwner.set(statement.ownerSymbolStableKey, bucket);
  }

  const candidateTraces: DelphiFlowTrace[] = [];

  for (const event of input.delphiEventMap) {
    const warnings = [...event.warnings];
    const steps: DelphiFlowTrace["steps"] = [
      {
        id: "component",
        type: "ui_component",
        label: `${event.componentClass}.${event.componentName}`,
        filePath: event.filePath,
        lineNumber: event.lineNumber,
        confidence: "high",
        evidence: "DFM/FMX component event binding",
      },
      {
        id: "event",
        type: "event",
        label: event.eventName,
        filePath: event.filePath,
        lineNumber: event.lineNumber,
        confidence: "high",
        evidence: `${event.eventName} = ${event.handlerName}`,
      },
    ];
    const visited = new Set<string>();
    const affectedTables = new Set<string>();
    const affectedFieldKeys = new Map<string, { table: string; field: string; operation: "read" | "write" | "calculate" | "unknown" }>();
    let truncated = false;
    let unresolvedTransition = event.status === "unresolved";

    const handlerResolution = resolveDelphiSymbol({
      symbols: input.symbols,
      qualifiedName: event.resolvedMethod ?? `${event.formClass ?? `T${event.formName}`}.${event.handlerName}`,
      name: event.handlerName,
      sourceFile: event.resolvedFile,
      ownerName: event.formClass ?? `T${event.formName}`,
      pascalUnit: baseNameWithoutExtension(event.filePath),
    });
    const handler = handlerResolution.symbol;

    if (handler) {
      steps.push({
        id: `handler:${handler.stableKey}`,
        type: "handler",
        label: handler.qualifiedName ?? handler.name,
        filePath: handler.file,
        lineNumber: handler.startLine,
        confidence: event.warnings.length > 0 ? "medium" : "high",
        evidence: `Resolved handler for ${event.handlerName} via ${handlerResolution.strategy}`,
      });
    } else {
      unresolvedTransition = true;
      const detail = handlerResolution.ambiguous
        ? `Ambiguous handler ${event.handlerName}: ${formatDelphiResolverCandidates(handlerResolution.candidates).join("; ")}`
        : `Handler ${event.handlerName} was not resolved to a persisted Pascal symbol.`;
      warnings.push(detail);
      steps.push({ id: "handler:unresolved", type: "warning", label: detail, confidence: "low" });
    }

    const visit = (symbol: AnalyzedSymbol | null, depth: number) => {
      if (!symbol || visited.has(symbol.stableKey)) return;
      if (depth > FLOW_TRACE_LIMITS.maxCallDepth) {
        truncated = true;
        unresolvedTransition = true;
        warnings.push(`Call traversal exceeded depth ${FLOW_TRACE_LIMITS.maxCallDepth}.`);
        return;
      }
      visited.add(symbol.stableKey);

      for (const statement of (sqlByOwner.get(symbol.stableKey) ?? []).sort((left, right) => left.startLine - right.startLine || left.stableKey.localeCompare(right.stableKey))) {
        if (steps.length >= FLOW_TRACE_LIMITS.maxStepsPerTrace) {
          truncated = true;
          unresolvedTransition = true;
          warnings.push(`Call traversal exceeded step limit ${FLOW_TRACE_LIMITS.maxStepsPerTrace}.`);
          return;
        }
        steps.push({
          id: `sql:${statement.stableKey}`,
          type: "sql",
          label: `${statement.operation.toUpperCase()} ${statement.tables.map((table) => table.name).join(", ") || "unknown table"}`,
          filePath: statement.filePath,
          lineNumber: statement.startLine,
          operation:
            statement.operation === "select"
              ? "read"
              : statement.operation === "insert" || statement.operation === "update" || statement.operation === "delete"
                ? "write"
                : "unknown",
          confidence: statement.confidence,
          evidence: `${statement.startLine}-${statement.endLine}: ${statement.normalizedSql}`,
        });
        if (statement.dynamic) warnings.push("Dynamic SQL lowers flow confidence.");
        for (const table of statement.tables) {
          if (table.operation !== "unknown") {
            affectedTables.add(table.name);
          }
          steps.push({
            id: `table:${statement.stableKey}:${table.name}`,
            type: "table",
            label: table.name,
            operation: table.operation === "unknown" ? "unknown" : table.operation,
            confidence: statement.confidence,
          });
        }
        for (const field of statement.fields) {
          const key = `${field.table}.${field.field}.${field.operation}`;
          affectedFieldKeys.set(key, field);
          steps.push({
            id: `field:${statement.stableKey}:${key}`,
            type: "field",
            label: `${field.table}.${field.field}`,
            operation: field.operation,
            confidence: statement.confidence,
          });
        }
      }

      for (const dependency of [...(callsBySource.get(symbol.stableKey) ?? [])].sort((left, right) => left.line - right.line || left.toName.localeCompare(right.toName))) {
        if (steps.length >= FLOW_TRACE_LIMITS.maxStepsPerTrace) {
          truncated = true;
          unresolvedTransition = true;
          warnings.push(`Call traversal exceeded step limit ${FLOW_TRACE_LIMITS.maxStepsPerTrace}.`);
          return;
        }
        const resolution = resolveDelphiSymbol({
          symbols: input.symbols,
          stableKey: dependency.to,
          qualifiedName: dependency.toName,
          name: dependency.toName,
          ownerName: ownerName(symbol),
          sourceFile: symbol.file,
          pascalUnit: baseNameWithoutExtension(symbol.file),
        });
        const target = resolution.symbol;
        if (!target) {
          unresolvedTransition = true;
          const detail = resolution.ambiguous
            ? `Ambiguous call target ${dependency.toName}: ${formatDelphiResolverCandidates(resolution.candidates).join("; ")}`
            : `Call target ${dependency.toName} was not resolved.`;
          warnings.push(detail);
          steps.push({ id: `call:unresolved:${dependency.line}:${dependency.toName}`, type: "warning", label: detail, lineNumber: dependency.line, confidence: "low" });
          continue;
        }
        steps.push({
          id: `call:${dependency.from}:${target.stableKey}:${dependency.line}`,
          type: "call",
          label: target.qualifiedName ?? target.name,
          filePath: target.file,
          lineNumber: target.startLine,
          confidence: resolution.strategy === "stable_key" || resolution.strategy === "qualified_name" ? "high" : "medium",
          evidence: `${dependency.fromName} -> ${dependency.toName} (${resolution.strategy})`,
        });
        visit(target, depth + 1);
      }
    };

    visit(handler, 0);
    const finalWarnings = sortedUniqueWarnings(warnings);
    const status = event.status === "unresolved" ? "unresolved" : unresolvedTransition || truncated ? "partial" : "complete";
    candidateTraces.push({
      stableKey: `${stablePart(event.formName)}:${stablePart(event.componentName)}:${stablePart(event.eventName)}:${stablePart(event.handlerName)}`,
      formName: event.formName,
      formClass: event.formClass,
      componentName: event.componentName,
      componentClass: event.componentClass,
      eventName: event.eventName,
      handlerName: event.handlerName,
      resolvedHandler: handler?.qualifiedName ?? event.resolvedMethod ?? undefined,
      status,
      confidence: status === "complete" ? confidenceForWarnings(finalWarnings) : status === "partial" ? "medium" : "low",
      steps: steps.slice(0, FLOW_TRACE_LIMITS.maxStepsPerTrace),
      affectedTables: Array.from(affectedTables).sort((left, right) => left.localeCompare(right)),
      affectedFields: Array.from(affectedFieldKeys.values()).sort((left, right) => left.table.localeCompare(right.table) || left.field.localeCompare(right.field) || left.operation.localeCompare(right.operation)),
      warnings: finalWarnings,
      truncated,
    });
  }

  for (const binding of input.delphiDataBindings) {
    const warnings = [...binding.warnings];
    const affectedFields = binding.dataField && binding.resolvedTable
      ? [{ table: binding.resolvedTable, field: binding.dataField, operation: binding.accessHint === "read-only" ? "read" as const : "unknown" as const }]
      : [];
    if (binding.dataSet && !binding.resolvedTable) {
      warnings.push("DataSet component was resolved, but its database table could not be determined statically.");
    }
    candidateTraces.push({
      stableKey: `${stablePart(binding.formName)}:${stablePart(binding.componentName)}:binding:${stablePart(binding.dataField)}:${stablePart(binding.dataSet)}`,
      formName: binding.formName,
      componentName: binding.componentName,
      componentClass: binding.componentClass,
      status: binding.confidence === "high" && binding.resolvedTable ? "complete" : binding.confidence === "low" ? "unresolved" : "partial",
      confidence: binding.resolvedTable ? binding.confidence : binding.confidence === "high" ? "medium" : binding.confidence,
      steps: [
        { id: "component", type: "ui_component", label: `${binding.componentClass}.${binding.componentName}`, filePath: binding.sourceFile, lineNumber: binding.lineNumber, confidence: "high" },
        { id: "binding", type: "data_binding", label: `DataSource ${binding.dataSource ?? "unresolved"} -> DataSet ${binding.dataSet ?? "unresolved"}`, filePath: binding.sourceFile, lineNumber: binding.lineNumber, confidence: binding.confidence },
        ...(binding.resolvedTable ? [{ id: "table", type: "table" as const, label: binding.resolvedTable, filePath: binding.sourceFile, lineNumber: binding.lineNumber, operation: "unknown" as const, confidence: binding.confidence }] : []),
        ...(binding.dataField
          ? [{
              id: "field",
              type: "field" as const,
              label: binding.resolvedTable ? `${binding.resolvedTable}.${binding.dataField}` : binding.dataField,
              filePath: binding.sourceFile,
              lineNumber: binding.lineNumber,
              operation: affectedFields[0]?.operation ?? "unknown",
              confidence: binding.resolvedTable ? binding.confidence : "medium" as const,
            }]
          : []),
      ],
      affectedTables: binding.resolvedTable ? [binding.resolvedTable] : [],
      affectedFields,
      warnings: sortedUniqueWarnings(warnings),
      truncated: false,
    });
  }

  const traces: DelphiFlowTrace[] = candidateTraces
    .sort((left, right) => left.formName.localeCompare(right.formName) || left.componentName.localeCompare(right.componentName) || (left.eventName ?? "").localeCompare(right.eventName ?? "") || left.stableKey.localeCompare(right.stableKey))
    .slice(0, FLOW_TRACE_LIMITS.maxTracesPerRun)
    .map((trace, index, all) => {
      if (candidateTraces.length <= FLOW_TRACE_LIMITS.maxTracesPerRun) return trace;
      if (index !== all.length - 1 && !trace.warnings.includes("FLOW_TRACE_LIMIT_REACHED")) return trace;
      return {
        ...trace,
        status: (trace.status === "unresolved" ? "unresolved" : "partial") as DelphiFlowTrace["status"],
        confidence: trace.confidence === "high" ? "medium" : trace.confidence,
        warnings: sortedUniqueWarnings([...trace.warnings, `FLOW_TRACE_LIMIT_REACHED: persisted ${FLOW_TRACE_LIMITS.maxTracesPerRun} of ${candidateTraces.length} candidate traces.`]),
      };
    });

  return {
    traces,
    summary: {
      candidateTraceCount: candidateTraces.length,
      persistedTraceCount: traces.length,
      globalTruncated: candidateTraces.length > FLOW_TRACE_LIMITS.maxTracesPerRun,
    },
  };
}
