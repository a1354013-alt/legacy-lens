import { describe, expect, it } from "vitest";
import { buildDelphiFlowTraces } from "./flowTracer";
import { buildSymbolStableKey, type AnalyzedSymbol } from "./types";

function symbol(name: string, line: number): AnalyzedSymbol {
  return {
    stableKey: buildSymbolStableKey({ file: "MainForm.pas", name, startLine: line }),
    name,
    qualifiedName: `TOrderForm.${name}`,
    type: "method",
    file: "MainForm.pas",
    startLine: line,
    endLine: line + 3,
  };
}

describe("Delphi flow tracer", () => {
  it("builds an event-to-SQL trace with write and read fields", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const validateOrder = symbol("ValidateOrder", 20);
    const saveOrder = symbol("SaveOrder", 30);

    const result = buildDelphiFlowTraces({
      delphiEventMap: [
        {
          formName: "OrderForm",
          formClass: "TOrderForm",
          componentName: "btnSave",
          componentClass: "TButton",
          eventName: "OnClick",
          handlerName: "btnSaveClick",
          filePath: "MainForm.dfm",
          lineNumber: 4,
          resolvedMethod: "TOrderForm.btnSaveClick",
          resolvedFile: "MainForm.pas",
          status: "resolved",
          warnings: [],
        },
      ],
      delphiDataBindings: [],
      symbols: [btnSaveClick, validateOrder, saveOrder],
      dependencies: [
        { from: btnSaveClick.stableKey, to: validateOrder.stableKey, fromName: "btnSaveClick", toName: "ValidateOrder", type: "calls", line: 12 },
        { from: validateOrder.stableKey, to: saveOrder.stableKey, fromName: "ValidateOrder", toName: "SaveOrder", type: "calls", line: 22 },
      ],
      sqlStatements: [
        {
          stableKey: "sql-1",
          ownerSymbolStableKey: saveOrder.stableKey,
          ownerSymbolName: "TOrderForm.SaveOrder",
          filePath: "MainForm.pas",
          startLine: 32,
          endLine: 35,
          operation: "update",
          normalizedSql: "UPDATE dbo.ORDER_M SET STATUS = :STATUS, UPDATE_USER = :UPDATE_USER WHERE ORDER_ID = :ORDER_ID",
          tables: [{ name: "dbo.ORDER_M", operation: "write" }],
          fields: [
            { table: "dbo.ORDER_M", field: "STATUS", operation: "write" },
            { table: "dbo.ORDER_M", field: "UPDATE_USER", operation: "write" },
            { table: "dbo.ORDER_M", field: "ORDER_ID", operation: "read" },
          ],
          dynamic: false,
          confidence: "high",
          warnings: [],
        },
      ],
    });

    expect(result.traces).toHaveLength(1);
    expect(result.summary).toEqual({ candidateTraceCount: 1, persistedTraceCount: 1, globalTruncated: false });
    expect(result.traces[0]?.status).toBe("complete");
    expect(result.traces[0]?.steps.map((step) => step.label)).toEqual(
      expect.arrayContaining(["TButton.btnSave", "OnClick", "TOrderForm.btnSaveClick", "TOrderForm.ValidateOrder", "TOrderForm.SaveOrder", "UPDATE dbo.ORDER_M"])
    );
    expect(result.traces[0]?.affectedFields).toEqual(
      expect.arrayContaining([
        { table: "dbo.ORDER_M", field: "STATUS", operation: "write" },
        { table: "dbo.ORDER_M", field: "UPDATE_USER", operation: "write" },
        { table: "dbo.ORDER_M", field: "ORDER_ID", operation: "read" },
      ])
    );
  });

  it("does not follow generic references as call edges", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const referencedOnly = symbol("ReferencedOnly", 20);

    const result = buildDelphiFlowTraces({
      delphiEventMap: [
        {
          formName: "OrderForm",
          formClass: "TOrderForm",
          componentName: "btnSave",
          componentClass: "TButton",
          eventName: "OnClick",
          handlerName: "btnSaveClick",
          filePath: "MainForm.dfm",
          lineNumber: 4,
          resolvedMethod: "TOrderForm.btnSaveClick",
          resolvedFile: "MainForm.pas",
          status: "resolved",
          warnings: [],
        },
      ],
      delphiDataBindings: [],
      symbols: [btnSaveClick, referencedOnly],
      dependencies: [
        { from: btnSaveClick.stableKey, to: referencedOnly.stableKey, fromName: "btnSaveClick", toName: "ReferencedOnly", type: "references", line: 12 },
      ],
      sqlStatements: [],
    });

    expect(result.traces[0]?.steps.map((step) => step.label)).not.toContain("TOrderForm.ReferencedOnly");
  });

  it("resolves same-name call targets progressively by source file", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const duplicateA = symbol("LoadOrder", 20);
    const duplicateB: AnalyzedSymbol = { ...symbol("LoadOrder", 40), file: "OtherForm.pas", stableKey: buildSymbolStableKey({ file: "OtherForm.pas", name: "TOrderForm.LoadOrder", startLine: 40 }) };

    const result = buildDelphiFlowTraces({
      delphiEventMap: [
        {
          formName: "OrderForm",
          formClass: "TOrderForm",
          componentName: "btnSave",
          componentClass: "TButton",
          eventName: "OnClick",
          handlerName: "btnSaveClick",
          filePath: "MainForm.dfm",
          lineNumber: 4,
          resolvedMethod: "TOrderForm.btnSaveClick",
          resolvedFile: "MainForm.pas",
          status: "resolved",
          warnings: [],
        },
      ],
      delphiDataBindings: [],
      symbols: [btnSaveClick, duplicateA, duplicateB],
      dependencies: [
        { from: btnSaveClick.stableKey, fromName: "btnSaveClick", toName: "LoadOrder", type: "calls", line: 12 },
      ],
      sqlStatements: [],
    });

    expect(result.traces[0]?.status).toBe("complete");
    expect(result.traces[0]?.steps.map((step) => step.label)).toContain("TOrderForm.LoadOrder");
    expect(result.traces[0]?.warnings.join(" ")).not.toContain("Ambiguous call target LoadOrder");
  });

  it("keeps truly ambiguous call targets unresolved after applying every discriminator", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const duplicateA = symbol("LoadOrder", 20);
    const duplicateB: AnalyzedSymbol = { ...symbol("LoadOrder", 40), startLine: 40, endLine: 43, stableKey: buildSymbolStableKey({ file: "MainForm.pas", name: "TOrderForm.LoadOrder", startLine: 40 }) };

    const result = buildDelphiFlowTraces({
      delphiEventMap: [
        {
          formName: "OrderForm",
          formClass: "TOrderForm",
          componentName: "btnSave",
          componentClass: "TButton",
          eventName: "OnClick",
          handlerName: "btnSaveClick",
          filePath: "MainForm.dfm",
          lineNumber: 4,
          resolvedMethod: "TOrderForm.btnSaveClick",
          resolvedFile: "MainForm.pas",
          status: "resolved",
          warnings: [],
        },
      ],
      delphiDataBindings: [],
      symbols: [btnSaveClick, duplicateA, duplicateB],
      dependencies: [
        { from: btnSaveClick.stableKey, fromName: "btnSaveClick", toName: "LoadOrder", type: "calls", line: 12 },
      ],
      sqlStatements: [],
    });

    expect(result.traces[0]?.status).toBe("partial");
    expect(result.traces[0]?.warnings.join(" ")).toContain("Ambiguous call target LoadOrder");
  });

  it("discloses direct call cycles as structured warnings", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const saveOrder = symbol("SaveOrder", 20);

    const result = buildDelphiFlowTraces({
      delphiEventMap: [
        {
          formName: "OrderForm",
          formClass: "TOrderForm",
          componentName: "btnSave",
          componentClass: "TButton",
          eventName: "OnClick",
          handlerName: "btnSaveClick",
          filePath: "MainForm.dfm",
          lineNumber: 4,
          resolvedMethod: "TOrderForm.btnSaveClick",
          resolvedFile: "MainForm.pas",
          status: "resolved",
          warnings: [],
        },
      ],
      delphiDataBindings: [],
      symbols: [btnSaveClick, saveOrder],
      dependencies: [
        { from: btnSaveClick.stableKey, to: saveOrder.stableKey, fromName: "btnSaveClick", toName: "SaveOrder", type: "calls", line: 12 },
        { from: saveOrder.stableKey, to: btnSaveClick.stableKey, fromName: "SaveOrder", toName: "btnSaveClick", type: "calls", line: 22 },
      ],
      sqlStatements: [],
    });

    expect(result.traces[0]?.status).toBe("partial");
    expect(result.traces[0]?.warnings.join(" ")).toContain("FLOW_TRACE_CALL_CYCLE");
  });

  it("adds a deterministic warning when step limits are reached mid-SQL expansion", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const saveOrder = symbol("SaveOrder", 20);
    const result = buildDelphiFlowTraces({
      delphiEventMap: [
        {
          formName: "OrderForm",
          formClass: "TOrderForm",
          componentName: "btnSave",
          componentClass: "TButton",
          eventName: "OnClick",
          handlerName: "btnSaveClick",
          filePath: "MainForm.dfm",
          lineNumber: 4,
          resolvedMethod: "TOrderForm.btnSaveClick",
          resolvedFile: "MainForm.pas",
          status: "resolved",
          warnings: [],
        },
      ],
      delphiDataBindings: [],
      symbols: [btnSaveClick, saveOrder],
      dependencies: [{ from: btnSaveClick.stableKey, to: saveOrder.stableKey, fromName: "btnSaveClick", toName: "SaveOrder", type: "calls", line: 12 }],
      sqlStatements: [
        {
          stableKey: "sql-1",
          ownerSymbolStableKey: saveOrder.stableKey,
          ownerSymbolName: "TOrderForm.SaveOrder",
          filePath: "MainForm.pas",
          startLine: 32,
          endLine: 35,
          operation: "select",
          normalizedSql: "SELECT A, B, C FROM dbo.ORDER_M",
          tables: [{ name: "dbo.ORDER_M", operation: "read" }],
          fields: [
            { table: "dbo.ORDER_M", field: "A", operation: "read" },
            { table: "dbo.ORDER_M", field: "B", operation: "read" },
            { table: "dbo.ORDER_M", field: "C", operation: "read" },
          ],
          dynamic: false,
          confidence: "high",
          warnings: [],
        },
      ],
    }, { maxStepsPerTrace: 5 });

    expect(result.traces[0]?.truncated).toBe(true);
    expect(result.traces[0]?.warnings.join(" ")).toContain("FLOW_TRACE_STEP_LIMIT_REACHED");
  });

  it("keeps dataset component bindings out of affected tables when no static table mapping exists", () => {
    const result = buildDelphiFlowTraces({
      delphiEventMap: [],
      delphiDataBindings: [
        {
          formName: "OrderForm",
          componentName: "edtName",
          componentClass: "TDBEdit",
          dataSource: "dsCustomer",
          dataSet: "qryCustomer",
          dataField: "CUSTOMER_NAME",
          readOnly: false,
          enabled: true,
          visible: true,
          accessHint: "read-write",
          confidence: "high",
          sourceFile: "OrderForm.dfm",
          lineNumber: 10,
          warnings: [],
        },
      ],
      symbols: [],
      dependencies: [],
      sqlStatements: [],
    });

    expect(result.traces[0]?.affectedTables).toEqual([]);
    expect(result.traces[0]?.steps.map((step) => step.label)).toContain("CUSTOMER_NAME");
    expect(result.traces[0]?.steps.map((step) => step.label)).not.toContain("qryCustomer.CUSTOMER_NAME");
    expect(result.traces[0]?.warnings.join(" ")).toContain("database table could not be determined statically");
  });

  it("uses resolved table mappings for data bindings when static table evidence exists", () => {
    const result = buildDelphiFlowTraces({
      delphiEventMap: [],
      delphiDataBindings: [
        {
          formName: "OrderForm",
          componentName: "edtName",
          componentClass: "TDBEdit",
          dataSource: "dsCustomer",
          dataSet: "qryCustomer",
          resolvedTable: "dbo.CUSTOMER",
          dataField: "CUSTOMER_NAME",
          readOnly: false,
          enabled: true,
          visible: true,
          accessHint: "read-write",
          confidence: "high",
          sourceFile: "OrderForm.dfm",
          lineNumber: 10,
          warnings: [],
        },
      ],
      symbols: [],
      dependencies: [],
      sqlStatements: [],
    });

    expect(result.traces[0]?.affectedTables).toEqual(["dbo.CUSTOMER"]);
    expect(result.traces[0]?.steps.map((step) => step.label)).toContain("dbo.CUSTOMER.CUSTOMER_NAME");
  });

  it("reports global trace truncation when candidate traces exceed the configured limit", () => {
    const result = buildDelphiFlowTraces({
      delphiEventMap: [
        {
          formName: "FormA",
          formClass: "TFormA",
          componentName: "BtnA",
          componentClass: "TButton",
          eventName: "OnClick",
          handlerName: "BtnAClick",
          filePath: "FormA.dfm",
          lineNumber: 1,
          resolvedMethod: "TFormA.BtnAClick",
          resolvedFile: "MainForm.pas",
          status: "resolved",
          warnings: [],
        },
        {
          formName: "FormB",
          formClass: "TFormB",
          componentName: "BtnB",
          componentClass: "TButton",
          eventName: "OnClick",
          handlerName: "BtnBClick",
          filePath: "FormB.dfm",
          lineNumber: 1,
          resolvedMethod: "TFormB.BtnBClick",
          resolvedFile: "OtherForm.pas",
          status: "resolved",
          warnings: [],
        },
      ],
      delphiDataBindings: [],
      symbols: [
        { ...symbol("BtnAClick", 10), qualifiedName: "TFormA.BtnAClick" },
        { ...symbol("BtnBClick", 20), qualifiedName: "TFormB.BtnBClick", file: "OtherForm.pas", stableKey: buildSymbolStableKey({ file: "OtherForm.pas", name: "TFormB.BtnBClick", startLine: 20 }) },
      ],
      dependencies: [],
      sqlStatements: [],
    }, { maxTracesPerRun: 1 });

    expect(result.summary).toEqual({ candidateTraceCount: 2, persistedTraceCount: 1, globalTruncated: true });
    expect(result.traces[0]?.warnings.join(" ")).toContain("FLOW_TRACE_LIMIT_REACHED");
  });

  it("matches source files case-insensitively during handler and call resolution", () => {
    const result = buildDelphiFlowTraces({
      delphiEventMap: [
        {
          formName: "OrderForm",
          formClass: "TOrderForm",
          componentName: "btnSave",
          componentClass: "TButton",
          eventName: "OnClick",
          handlerName: "btnSaveClick",
          filePath: "Forms/MainForm.dfm",
          lineNumber: 4,
          resolvedMethod: "TOrderForm.btnSaveClick",
          resolvedFile: "forms\\mainform.pas",
          status: "resolved",
          warnings: [],
        },
      ],
      delphiDataBindings: [],
      symbols: [
        {
          stableKey: buildSymbolStableKey({ file: "Forms/MainForm.pas", name: "TOrderForm.btnSaveClick", startLine: 10 }),
          name: "btnSaveClick",
          qualifiedName: "TOrderForm.btnSaveClick",
          type: "method",
          file: "Forms/MainForm.pas",
          startLine: 10,
          endLine: 14,
        },
      ],
      dependencies: [],
      sqlStatements: [],
    });

    expect(result.traces[0]?.resolvedHandler).toBe("TOrderForm.btnSaveClick");
    expect(result.traces[0]?.status).toBe("complete");
  });

  it("discloses indirect call cycles as structured warnings", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const validateOrder = symbol("ValidateOrder", 20);
    const saveOrder = symbol("SaveOrder", 30);
    const result = buildDelphiFlowTraces({
      delphiEventMap: [{ formName: "OrderForm", formClass: "TOrderForm", componentName: "btnSave", componentClass: "TButton", eventName: "OnClick", handlerName: "btnSaveClick", filePath: "MainForm.dfm", lineNumber: 4, resolvedMethod: "TOrderForm.btnSaveClick", resolvedFile: "MainForm.pas", status: "resolved", warnings: [] }],
      delphiDataBindings: [],
      symbols: [btnSaveClick, validateOrder, saveOrder],
      dependencies: [
        { from: btnSaveClick.stableKey, to: validateOrder.stableKey, fromName: "btnSaveClick", toName: "ValidateOrder", type: "calls", line: 12 },
        { from: validateOrder.stableKey, to: saveOrder.stableKey, fromName: "ValidateOrder", toName: "SaveOrder", type: "calls", line: 22 },
        { from: saveOrder.stableKey, to: validateOrder.stableKey, fromName: "SaveOrder", toName: "ValidateOrder", type: "calls", line: 32 },
      ],
      sqlStatements: [],
    });

    expect(result.traces[0]?.status).toBe("partial");
    expect(result.traces[0]?.warnings.join(" ")).toContain("FLOW_TRACE_CALL_CYCLE");
  });

  it("stops traversal at the maximum call depth", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const saveOrder = symbol("SaveOrder", 20);
    const persistOrder = symbol("PersistOrder", 30);
    const result = buildDelphiFlowTraces({
      delphiEventMap: [{ formName: "OrderForm", formClass: "TOrderForm", componentName: "btnSave", componentClass: "TButton", eventName: "OnClick", handlerName: "btnSaveClick", filePath: "MainForm.dfm", lineNumber: 4, resolvedMethod: "TOrderForm.btnSaveClick", resolvedFile: "MainForm.pas", status: "resolved", warnings: [] }],
      delphiDataBindings: [],
      symbols: [btnSaveClick, saveOrder, persistOrder],
      dependencies: [
        { from: btnSaveClick.stableKey, to: saveOrder.stableKey, fromName: "btnSaveClick", toName: "SaveOrder", type: "calls", line: 12 },
        { from: saveOrder.stableKey, to: persistOrder.stableKey, fromName: "SaveOrder", toName: "PersistOrder", type: "calls", line: 22 },
      ],
      sqlStatements: [],
    }, { maxCallDepth: 1 });

    expect(result.traces[0]?.truncated).toBe(true);
    expect(result.traces[0]?.warnings.join(" ")).toContain("FLOW_TRACE_MAX_CALL_DEPTH_REACHED");
  });

  it("keeps unresolved handlers unresolved", () => {
    const result = buildDelphiFlowTraces({
      delphiEventMap: [{ formName: "OrderForm", formClass: "TOrderForm", componentName: "btnSave", componentClass: "TButton", eventName: "OnClick", handlerName: "btnSaveClick", filePath: "MainForm.dfm", lineNumber: 4, resolvedMethod: null, resolvedFile: null, status: "unresolved", warnings: ["handler missing"] }],
      delphiDataBindings: [],
      symbols: [],
      dependencies: [],
      sqlStatements: [],
    });

    expect(result.traces[0]?.status).toBe("unresolved");
    expect(result.traces[0]?.warnings.join(" ")).toContain("handler missing");
  });

  it("keeps dynamic and EXECUTE SQL evidence with lower confidence warnings", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const result = buildDelphiFlowTraces({
      delphiEventMap: [{ formName: "OrderForm", formClass: "TOrderForm", componentName: "btnSave", componentClass: "TButton", eventName: "OnClick", handlerName: "btnSaveClick", filePath: "MainForm.dfm", lineNumber: 4, resolvedMethod: "TOrderForm.btnSaveClick", resolvedFile: "MainForm.pas", status: "resolved", warnings: [] }],
      delphiDataBindings: [],
      symbols: [btnSaveClick],
      dependencies: [],
      sqlStatements: [
        { stableKey: "sql-dynamic", ownerSymbolStableKey: btnSaveClick.stableKey, ownerSymbolName: "TOrderForm.btnSaveClick", filePath: "MainForm.pas", startLine: 12, endLine: 12, operation: "execute", normalizedSql: "EXECUTE IMMEDIATE :SQL_TEXT", tables: [{ name: "unknown", operation: "unknown" }], fields: [], dynamic: true, confidence: "low", warnings: ["dynamic sql"] },
      ],
    });

    expect(result.traces[0]?.steps.map((step) => step.label)).toContain("EXECUTE unknown");
    expect(result.traces[0]?.warnings.join(" ")).toContain("Dynamic SQL lowers flow confidence");
  });

  it("persists multiple SQL statements owned by one handler", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const result = buildDelphiFlowTraces({
      delphiEventMap: [{ formName: "OrderForm", formClass: "TOrderForm", componentName: "btnSave", componentClass: "TButton", eventName: "OnClick", handlerName: "btnSaveClick", filePath: "MainForm.dfm", lineNumber: 4, resolvedMethod: "TOrderForm.btnSaveClick", resolvedFile: "MainForm.pas", status: "resolved", warnings: [] }],
      delphiDataBindings: [],
      symbols: [btnSaveClick],
      dependencies: [],
      sqlStatements: [
        { stableKey: "sql-1", ownerSymbolStableKey: btnSaveClick.stableKey, ownerSymbolName: "TOrderForm.btnSaveClick", filePath: "MainForm.pas", startLine: 12, endLine: 12, operation: "select", normalizedSql: "SELECT ID FROM ORDERS", tables: [{ name: "ORDERS", operation: "read" }], fields: [{ table: "ORDERS", field: "ID", operation: "read" }], dynamic: false, confidence: "high", warnings: [] },
        { stableKey: "sql-2", ownerSymbolStableKey: btnSaveClick.stableKey, ownerSymbolName: "TOrderForm.btnSaveClick", filePath: "MainForm.pas", startLine: 13, endLine: 13, operation: "update", normalizedSql: "UPDATE ORDERS SET STATUS = :STATUS", tables: [{ name: "ORDERS", operation: "write" }], fields: [{ table: "ORDERS", field: "STATUS", operation: "write" }], dynamic: false, confidence: "high", warnings: [] },
      ],
    });

    expect(result.traces[0]?.affectedFields).toEqual(
      expect.arrayContaining([
        { table: "ORDERS", field: "ID", operation: "read" },
        { table: "ORDERS", field: "STATUS", operation: "write" },
      ])
    );
  });

  it("keeps event paths without SQL as complete static UI paths", () => {
    const btnSaveClick = symbol("btnSaveClick", 10);
    const result = buildDelphiFlowTraces({
      delphiEventMap: [{ formName: "OrderForm", formClass: "TOrderForm", componentName: "btnSave", componentClass: "TButton", eventName: "OnClick", handlerName: "btnSaveClick", filePath: "MainForm.dfm", lineNumber: 4, resolvedMethod: "TOrderForm.btnSaveClick", resolvedFile: "MainForm.pas", status: "resolved", warnings: [] }],
      delphiDataBindings: [],
      symbols: [btnSaveClick],
      dependencies: [],
      sqlStatements: [],
    });

    expect(result.traces[0]?.status).toBe("complete");
    expect(result.traces[0]?.affectedTables).toEqual([]);
  });
});
