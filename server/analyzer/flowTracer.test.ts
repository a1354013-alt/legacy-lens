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

    const traces = buildDelphiFlowTraces({
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

    expect(traces).toHaveLength(1);
    expect(traces[0]?.status).toBe("complete");
    expect(traces[0]?.steps.map((step) => step.label)).toEqual(
      expect.arrayContaining(["TButton.btnSave", "OnClick", "TOrderForm.btnSaveClick", "TOrderForm.ValidateOrder", "TOrderForm.SaveOrder", "UPDATE dbo.ORDER_M"])
    );
    expect(traces[0]?.affectedFields).toEqual(
      expect.arrayContaining([
        { table: "dbo.ORDER_M", field: "STATUS", operation: "write" },
        { table: "dbo.ORDER_M", field: "UPDATE_USER", operation: "write" },
        { table: "dbo.ORDER_M", field: "ORDER_ID", operation: "read" },
      ])
    );
  });
});
