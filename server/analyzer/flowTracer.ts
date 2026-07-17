import type { DelphiFlowTrace, SqlStatementEvidence } from "../../shared/contracts";
import type { DelphiDataBinding, DelphiEventMapEntry, SymbolDependency, AnalyzedSymbol } from "./types";

export const FLOW_TRACE_LIMITS = {
  maxCallDepth: 8,
  maxStepsPerTrace: 200,
  maxTracesPerRun: 2_000,
} as const;

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function stablePart(value: string | null | undefined) {
  return (value ?? "unknown").replace(/[^\w.-]+/g, "_");
}

function confidenceForWarnings(warnings: string[]) {
  if (warnings.length >= 2) return "low" as const;
  if (warnings.length === 1) return "medium" as const;
  return "high" as const;
}

export function buildDelphiFlowTraces(input: {
  delphiEventMap: DelphiEventMapEntry[];
  delphiDataBindings: DelphiDataBinding[];
  symbols: AnalyzedSymbol[];
  dependencies: SymbolDependency[];
  sqlStatements: SqlStatementEvidence[];
}): DelphiFlowTrace[] {
  const symbolByKey = new Map(input.symbols.map((symbol) => [symbol.stableKey, symbol]));
  const symbolsByName = new Map<string, AnalyzedSymbol[]>();
  for (const symbol of input.symbols) {
    for (const key of [symbol.name, symbol.qualifiedName].filter((value): value is string => Boolean(value))) {
      const normalized = normalize(key);
      const bucket = symbolsByName.get(normalized) ?? [];
      bucket.push(symbol);
      symbolsByName.set(normalized, bucket);
    }
  }

  const callsBySource = new Map<string, SymbolDependency[]>();
  for (const dependency of input.dependencies) {
    if (dependency.type !== "calls" && dependency.type !== "references") continue;
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

  const traces: DelphiFlowTrace[] = [];
  for (const event of input.delphiEventMap) {
    if (traces.length >= FLOW_TRACE_LIMITS.maxTracesPerRun) break;
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

    const handlerCandidates = event.resolvedMethod ? (symbolsByName.get(normalize(event.resolvedMethod)) ?? []) : [];
    const handler = handlerCandidates.find((symbol) => symbol.file === event.resolvedFile) ?? handlerCandidates[0] ?? null;
    if (handler) {
      steps.push({
        id: `handler:${handler.stableKey}`,
        type: "handler",
        label: handler.qualifiedName ?? handler.name,
        filePath: handler.file,
        lineNumber: handler.startLine,
        confidence: event.warnings.length > 0 ? "medium" : "high",
        evidence: `Resolved handler for ${event.handlerName}`,
      });
    } else {
      warnings.push(`Handler ${event.handlerName} was not resolved to a persisted Pascal symbol.`);
      steps.push({ id: "handler:unresolved", type: "warning", label: `Unresolved handler ${event.handlerName}`, confidence: "low" });
    }

    const visit = (symbol: AnalyzedSymbol | null, depth: number) => {
      if (!symbol || visited.has(symbol.stableKey)) return;
      if (depth > FLOW_TRACE_LIMITS.maxCallDepth) {
        truncated = true;
        warnings.push(`Call traversal exceeded depth ${FLOW_TRACE_LIMITS.maxCallDepth}.`);
        return;
      }
      visited.add(symbol.stableKey);

      for (const statement of sqlByOwner.get(symbol.stableKey) ?? []) {
        if (steps.length >= FLOW_TRACE_LIMITS.maxStepsPerTrace) {
          truncated = true;
          return;
        }
        steps.push({
          id: `sql:${statement.stableKey}`,
          type: "sql",
          label: `${statement.operation.toUpperCase()} ${statement.tables.map((table) => table.name).join(", ") || "unknown table"}`,
          filePath: statement.filePath,
          lineNumber: statement.startLine,
          operation: statement.operation === "select" ? "read" : statement.operation === "unknown" || statement.operation === "execute" ? "unknown" : "write",
          confidence: statement.confidence,
          evidence: statement.normalizedSql,
        });
        if (statement.dynamic) warnings.push("Dynamic SQL lowers flow confidence.");
        for (const table of statement.tables) {
          affectedTables.add(table.name);
          steps.push({
            id: `table:${statement.stableKey}:${table.name}`,
            type: "table",
            label: table.name,
            operation: table.operation,
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
          return;
        }
        const target = dependency.to ? symbolByKey.get(dependency.to) : (symbolsByName.get(normalize(dependency.toName)) ?? [])[0];
        if (!target) {
          unresolvedTransition = true;
          warnings.push(`Call target ${dependency.toName} was not resolved.`);
          steps.push({ id: `call:unresolved:${dependency.line}:${dependency.toName}`, type: "warning", label: `Unresolved call ${dependency.toName}`, lineNumber: dependency.line, confidence: "low" });
          continue;
        }
        steps.push({
          id: `call:${dependency.from}:${target.stableKey}:${dependency.line}`,
          type: "call",
          label: target.qualifiedName ?? target.name,
          filePath: target.file,
          lineNumber: target.startLine,
          confidence: "medium",
          evidence: `${dependency.fromName} -> ${dependency.toName}`,
        });
        visit(target, depth + 1);
      }
    };

    visit(handler, 0);
    const status = event.status === "unresolved" ? "unresolved" : unresolvedTransition || warnings.length > event.warnings.length || truncated ? "partial" : "complete";
    traces.push({
      stableKey: `${stablePart(event.formName)}:${stablePart(event.componentName)}:${stablePart(event.eventName)}:${stablePart(event.handlerName)}`,
      formName: event.formName,
      formClass: event.formClass,
      componentName: event.componentName,
      componentClass: event.componentClass,
      eventName: event.eventName,
      handlerName: event.handlerName,
      resolvedHandler: event.resolvedMethod ?? undefined,
      status,
      confidence: status === "complete" ? confidenceForWarnings(warnings) : status === "partial" ? "medium" : "low",
      steps: steps.slice(0, FLOW_TRACE_LIMITS.maxStepsPerTrace),
      affectedTables: Array.from(affectedTables).sort((left, right) => left.localeCompare(right)),
      affectedFields: Array.from(affectedFieldKeys.values()).sort((left, right) => left.table.localeCompare(right.table) || left.field.localeCompare(right.field) || left.operation.localeCompare(right.operation)),
      warnings: Array.from(new Set(warnings)),
      truncated,
    });
  }

  for (const binding of input.delphiDataBindings) {
    if (traces.length >= FLOW_TRACE_LIMITS.maxTracesPerRun) break;
    const warnings = [...binding.warnings];
    const affectedFields = binding.dataField
      ? [{ table: binding.dataSet ?? binding.dataSource ?? "unresolved", field: binding.dataField, operation: binding.accessHint === "read-only" ? "read" as const : "unknown" as const }]
      : [];
    traces.push({
      stableKey: `${stablePart(binding.formName)}:${stablePart(binding.componentName)}:binding:${stablePart(binding.dataField)}`,
      formName: binding.formName,
      componentName: binding.componentName,
      componentClass: binding.componentClass,
      status: binding.confidence === "high" ? "complete" : binding.confidence === "medium" ? "partial" : "unresolved",
      confidence: binding.confidence,
      steps: [
        { id: "component", type: "ui_component", label: `${binding.componentClass}.${binding.componentName}`, filePath: binding.sourceFile, lineNumber: binding.lineNumber, confidence: "high" },
        { id: "binding", type: "data_binding", label: `DataSource ${binding.dataSource ?? "unresolved"} -> ${binding.dataSet ?? "unresolved"}`, filePath: binding.sourceFile, lineNumber: binding.lineNumber, confidence: binding.confidence },
        ...(binding.dataField ? [{ id: "field", type: "field" as const, label: `${binding.dataSet ?? binding.dataSource ?? "unresolved"}.${binding.dataField}`, filePath: binding.sourceFile, lineNumber: binding.lineNumber, operation: affectedFields[0]?.operation, confidence: binding.confidence }] : []),
      ],
      affectedTables: affectedFields.map((field) => field.table),
      affectedFields,
      warnings,
      truncated: false,
    });
  }

  return traces.sort((left, right) => left.formName.localeCompare(right.formName) || left.componentName.localeCompare(right.componentName) || (left.eventName ?? "").localeCompare(right.eventName ?? ""));
}
