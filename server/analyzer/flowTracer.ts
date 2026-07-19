import type { DelphiFlowStep, DelphiFlowTrace, DelphiFlowTraceRunSummary, SqlStatementEvidence } from "../../shared/contracts";
import { formatDelphiResolverCandidates, resolveDelphiSymbol } from "./delphiSymbolResolver";
import type { DelphiDataBinding, DelphiEventMapEntry, SymbolDependency, AnalyzedSymbol } from "./types";

export const FLOW_TRACE_LIMITS = {
  maxCallDepth: 8,
  maxStepsPerTrace: 200,
  maxTracesPerRun: 2_000,
} as const;

const STEP_LIMIT_WARNING_CODE = "FLOW_TRACE_STEP_LIMIT_REACHED";
const CYCLE_WARNING_CODE = "FLOW_TRACE_CALL_CYCLE";

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

function sortSqlStatements(statements: SqlStatementEvidence[]) {
  return [...statements].sort((left, right) => left.startLine - right.startLine || left.stableKey.localeCompare(right.stableKey));
}

function sortDependencies(dependencies: SymbolDependency[]) {
  return [...dependencies].sort((left, right) => left.line - right.line || left.toName.localeCompare(right.toName));
}

function traceSortKey(trace: Pick<DelphiFlowTrace, "formName" | "componentName" | "eventName" | "stableKey">) {
  return [
    trace.formName.toLowerCase(),
    trace.componentName.toLowerCase(),
    (trace.eventName ?? "").toLowerCase(),
    trace.stableKey.toLowerCase(),
  ] as const;
}

function compareTraceSortKey(
  left: ReturnType<typeof traceSortKey>,
  right: ReturnType<typeof traceSortKey>
) {
  return left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]) || left[2].localeCompare(right[2]) || left[3].localeCompare(right[3]);
}

function createTraceStepBuilder(initialWarnings: string[]) {
  const steps: DelphiFlowStep[] = [];
  const warnings = [...initialWarnings];
  const warningSet = new Set(initialWarnings);
  let truncated = false;
  let unresolvedTransition = false;
  let stepLimitWarningAdded = false;

  const addWarning = (message: string) => {
    if (warningSet.has(message)) return;
    warningSet.add(message);
    warnings.push(message);
  };

  const appendStep = (step: DelphiFlowStep) => {
    steps.push(step);
  };

  const appendStepLimitWarning = () => {
    if (stepLimitWarningAdded) return;
    stepLimitWarningAdded = true;
    const label = `${STEP_LIMIT_WARNING_CODE}: trace stopped after ${FLOW_TRACE_LIMITS.maxStepsPerTrace} steps.`;
    addWarning(label);
    if (steps.length < FLOW_TRACE_LIMITS.maxStepsPerTrace) {
      appendStep({ id: `warning:${STEP_LIMIT_WARNING_CODE.toLowerCase()}`, type: "warning", label, confidence: "low" });
    }
  };

  const pushStep = (step: DelphiFlowStep) => {
    if (steps.length >= FLOW_TRACE_LIMITS.maxStepsPerTrace) {
      truncated = true;
      unresolvedTransition = true;
      appendStepLimitWarning();
      return false;
    }
    if (!stepLimitWarningAdded && step.type !== "warning" && steps.length === FLOW_TRACE_LIMITS.maxStepsPerTrace - 1) {
      truncated = true;
      unresolvedTransition = true;
      appendStepLimitWarning();
      return false;
    }
    appendStep(step);
    return true;
  };

  const addWarningStep = (message: string, details?: Partial<Pick<DelphiFlowStep, "id" | "filePath" | "lineNumber" | "evidence">>) => {
    addWarning(message);
    unresolvedTransition = true;
    return pushStep({
      id: details?.id ?? `warning:${stablePart(message)}`,
      type: "warning",
      label: message,
      confidence: "low",
      filePath: details?.filePath,
      lineNumber: details?.lineNumber,
      evidence: details?.evidence,
    });
  };

  return {
    steps,
    pushStep,
    addWarning,
    addWarningStep,
    getWarnings: () => sortedUniqueWarnings(warnings),
    markUnresolved: () => {
      unresolvedTransition = true;
    },
    markTruncated: () => {
      truncated = true;
      unresolvedTransition = true;
    },
    get truncated() {
      return truncated;
    },
    get unresolvedTransition() {
      return unresolvedTransition;
    },
  };
}

function buildEventTrace(input: {
  event: DelphiEventMapEntry;
  symbols: AnalyzedSymbol[];
  callsBySource: Map<string, SymbolDependency[]>;
  sqlByOwner: Map<string, SqlStatementEvidence[]>;
}): DelphiFlowTrace {
  const { event, symbols, callsBySource, sqlByOwner } = input;
  const builder = createTraceStepBuilder(event.warnings);
  const visited = new Set<string>();
  const activePath = new Set<string>();
  const activeStack: string[] = [];
  const activeLabels = new Map<string, string>();
  const affectedTables = new Set<string>();
  const affectedFieldKeys = new Map<string, { table: string; field: string; operation: "read" | "write" | "calculate" | "unknown" }>();
  let unresolvedTransition = event.status === "unresolved";

  builder.pushStep({
    id: "component",
    type: "ui_component",
    label: `${event.componentClass}.${event.componentName}`,
    filePath: event.filePath,
    lineNumber: event.lineNumber,
    confidence: "high",
    evidence: "DFM/FMX component event binding",
  });
  builder.pushStep({
    id: "event",
    type: "event",
    label: event.eventName,
    filePath: event.filePath,
    lineNumber: event.lineNumber,
    confidence: "high",
    evidence: `${event.eventName} = ${event.handlerName}`,
  });

  const handlerResolution = resolveDelphiSymbol({
    symbols,
    qualifiedName: event.resolvedMethod ?? `${event.formClass ?? `T${event.formName}`}.${event.handlerName}`,
    name: event.handlerName,
    sourceFile: event.resolvedFile,
    ownerName: event.formClass ?? `T${event.formName}`,
    pascalUnit: baseNameWithoutExtension(event.filePath),
  });
  const handler = handlerResolution.symbol;

  if (handler) {
    builder.pushStep({
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
    builder.addWarningStep(detail, { id: "handler:unresolved", filePath: event.resolvedFile ?? event.filePath, lineNumber: event.lineNumber });
  }

  const visit = (symbol: AnalyzedSymbol | null, depth: number) => {
    if (!symbol) return;

    if (activePath.has(symbol.stableKey)) {
      unresolvedTransition = true;
      builder.markTruncated();
      const cycleStart = activeStack.indexOf(symbol.stableKey);
      const cycleLabels = [...activeStack.slice(cycleStart).map((stableKey) => activeLabels.get(stableKey) ?? stableKey), activeLabels.get(symbol.stableKey) ?? symbol.stableKey];
      builder.addWarningStep(`${CYCLE_WARNING_CODE}: ${cycleLabels.join(" -> ")}`, {
        id: `warning:${CYCLE_WARNING_CODE.toLowerCase()}:${symbol.stableKey}`,
        filePath: symbol.file,
        lineNumber: symbol.startLine,
        evidence: cycleLabels.join(" -> "),
      });
      return;
    }

    if (visited.has(symbol.stableKey)) return;
    if (depth > FLOW_TRACE_LIMITS.maxCallDepth) {
      unresolvedTransition = true;
      builder.markTruncated();
      builder.addWarningStep(`FLOW_TRACE_MAX_CALL_DEPTH_REACHED: traversal exceeded depth ${FLOW_TRACE_LIMITS.maxCallDepth}.`, {
        id: `warning:max-depth:${symbol.stableKey}`,
        filePath: symbol.file,
        lineNumber: symbol.startLine,
      });
      return;
    }

    visited.add(symbol.stableKey);
    activePath.add(symbol.stableKey);
    activeStack.push(symbol.stableKey);
    activeLabels.set(symbol.stableKey, symbol.qualifiedName ?? symbol.name);

    for (const statement of sortSqlStatements(sqlByOwner.get(symbol.stableKey) ?? [])) {
      if (!builder.pushStep({
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
      })) {
        break;
      }

      if (statement.dynamic) {
        builder.addWarning("Dynamic SQL lowers flow confidence.");
      }

      for (const table of statement.tables) {
        if (table.operation !== "unknown") {
          affectedTables.add(table.name);
        }
        if (!builder.pushStep({
          id: `table:${statement.stableKey}:${table.name}`,
          type: "table",
          label: table.name,
          operation: table.operation === "unknown" ? "unknown" : table.operation,
          confidence: statement.confidence,
        })) {
          break;
        }
      }

      for (const field of statement.fields) {
        const key = `${field.table}.${field.field}.${field.operation}`;
        affectedFieldKeys.set(key, field);
        if (!builder.pushStep({
          id: `field:${statement.stableKey}:${key}`,
          type: "field",
          label: `${field.table}.${field.field}`,
          operation: field.operation,
          confidence: statement.confidence,
        })) {
          break;
        }
      }
    }

    for (const dependency of sortDependencies(callsBySource.get(symbol.stableKey) ?? [])) {
      const resolution = resolveDelphiSymbol({
        symbols,
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
        builder.addWarningStep(detail, {
          id: `call:unresolved:${dependency.line}:${dependency.toName}`,
          lineNumber: dependency.line,
          filePath: symbol.file,
        });
        continue;
      }

      if (!builder.pushStep({
        id: `call:${dependency.from}:${target.stableKey}:${dependency.line}`,
        type: "call",
        label: target.qualifiedName ?? target.name,
        filePath: target.file,
        lineNumber: target.startLine,
        confidence: resolution.strategy === "stable_key" || resolution.strategy === "qualified_name" ? "high" : "medium",
        evidence: `${dependency.fromName} -> ${dependency.toName} (${resolution.strategy})`,
      })) {
        break;
      }

      if (activePath.has(target.stableKey)) {
        unresolvedTransition = true;
        const cycleStart = activeStack.indexOf(target.stableKey);
        const cycleLabels = [...activeStack.slice(cycleStart).map((stableKey) => activeLabels.get(stableKey) ?? stableKey), activeLabels.get(target.stableKey) ?? target.stableKey];
        builder.addWarningStep(`${CYCLE_WARNING_CODE}: ${cycleLabels.join(" -> ")}`, {
          id: `warning:${CYCLE_WARNING_CODE.toLowerCase()}:${target.stableKey}`,
          filePath: target.file,
          lineNumber: dependency.line,
          evidence: cycleLabels.join(" -> "),
        });
        continue;
      }

      visit(target, depth + 1);
    }

    activeStack.pop();
    activePath.delete(symbol.stableKey);
  };

  visit(handler, 0);

  const finalWarnings = builder.getWarnings();
  const status = event.status === "unresolved" ? "unresolved" : unresolvedTransition || builder.unresolvedTransition || builder.truncated ? "partial" : "complete";
  return {
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
    steps: builder.steps,
    affectedTables: Array.from(affectedTables).sort((left, right) => left.localeCompare(right)),
    affectedFields: Array.from(affectedFieldKeys.values()).sort((left, right) => left.table.localeCompare(right.table) || left.field.localeCompare(right.field) || left.operation.localeCompare(right.operation)),
    warnings: finalWarnings,
    truncated: builder.truncated,
  };
}

function buildBindingTrace(binding: DelphiDataBinding): DelphiFlowTrace {
  const builder = createTraceStepBuilder(binding.warnings);
  const affectedFields = binding.dataField && binding.resolvedTable
    ? [{ table: binding.resolvedTable, field: binding.dataField, operation: binding.accessHint === "read-only" ? "read" as const : "unknown" as const }]
    : [];

  if (binding.dataSet && !binding.resolvedTable) {
    builder.addWarning("DataSet component was resolved, but its database table could not be determined statically.");
  }

  builder.pushStep({
    id: "component",
    type: "ui_component",
    label: `${binding.componentClass}.${binding.componentName}`,
    filePath: binding.sourceFile,
    lineNumber: binding.lineNumber,
    confidence: "high",
  });
  builder.pushStep({
    id: "binding",
    type: "data_binding",
    label: `DataSource ${binding.dataSource ?? "unresolved"} -> DataSet ${binding.dataSet ?? "unresolved"}`,
    filePath: binding.sourceFile,
    lineNumber: binding.lineNumber,
    confidence: binding.confidence,
  });
  if (binding.resolvedTable) {
    builder.pushStep({
      id: "table",
      type: "table",
      label: binding.resolvedTable,
      filePath: binding.sourceFile,
      lineNumber: binding.lineNumber,
      operation: "unknown",
      confidence: binding.confidence,
    });
  }
  if (binding.dataField) {
    builder.pushStep({
      id: "field",
      type: "field",
      label: binding.resolvedTable ? `${binding.resolvedTable}.${binding.dataField}` : binding.dataField,
      filePath: binding.sourceFile,
      lineNumber: binding.lineNumber,
      operation: affectedFields[0]?.operation ?? "unknown",
      confidence: binding.resolvedTable ? binding.confidence : "medium",
    });
  }

  const warnings = builder.getWarnings();
  return {
    stableKey: `${stablePart(binding.formName)}:${stablePart(binding.componentName)}:binding:${stablePart(binding.dataField)}:${stablePart(binding.dataSet)}`,
    formName: binding.formName,
    componentName: binding.componentName,
    componentClass: binding.componentClass,
    status: binding.confidence === "high" && binding.resolvedTable ? "complete" : binding.confidence === "low" ? "unresolved" : "partial",
    confidence: binding.resolvedTable ? binding.confidence : binding.confidence === "high" ? "medium" : binding.confidence,
    steps: builder.steps,
    affectedTables: binding.resolvedTable ? [binding.resolvedTable] : [],
    affectedFields,
    warnings,
    truncated: builder.truncated,
  };
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

  const traceDescriptors = [
    ...input.delphiEventMap.map((event) => ({
      kind: "event" as const,
      sortKey: traceSortKey({
        formName: event.formName,
        componentName: event.componentName,
        eventName: event.eventName,
        stableKey: `${stablePart(event.formName)}:${stablePart(event.componentName)}:${stablePart(event.eventName)}:${stablePart(event.handlerName)}`,
      }),
      build: () => buildEventTrace({ event, symbols: input.symbols, callsBySource, sqlByOwner }),
    })),
    ...input.delphiDataBindings.map((binding) => ({
      kind: "binding" as const,
      sortKey: traceSortKey({
        formName: binding.formName,
        componentName: binding.componentName,
        eventName: "",
        stableKey: `${stablePart(binding.formName)}:${stablePart(binding.componentName)}:binding:${stablePart(binding.dataField)}:${stablePart(binding.dataSet)}`,
      }),
      build: () => buildBindingTrace(binding),
    })),
  ].sort((left, right) => compareTraceSortKey(left.sortKey, right.sortKey) || left.kind.localeCompare(right.kind));

  const candidateTraceCount = traceDescriptors.length;
  const persistedDescriptors = traceDescriptors.slice(0, FLOW_TRACE_LIMITS.maxTracesPerRun);
  const globalTruncated = candidateTraceCount > FLOW_TRACE_LIMITS.maxTracesPerRun;
  const traces = persistedDescriptors.map((descriptor) => descriptor.build());

  if (globalTruncated && traces.length > 0) {
    const lastTrace = traces[traces.length - 1]!;
    const warning = `FLOW_TRACE_LIMIT_REACHED: persisted ${FLOW_TRACE_LIMITS.maxTracesPerRun} of ${candidateTraceCount} candidate traces.`;
    traces[traces.length - 1] = {
      ...lastTrace,
      status: lastTrace.status === "unresolved" ? "unresolved" : "partial",
      confidence: lastTrace.confidence === "high" ? "medium" : lastTrace.confidence,
      warnings: sortedUniqueWarnings([...lastTrace.warnings, warning]),
    };
  }

  return {
    traces,
    summary: {
      candidateTraceCount,
      persistedTraceCount: traces.length,
      globalTruncated,
    },
  };
}
