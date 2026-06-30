import { describe, expect, it } from "vitest";
import { DocumentGenerator } from "./documentGenerator";

describe("DocumentGenerator", () => {
  it("serializes RULES.yaml safely when fields contain YAML-sensitive characters", () => {
    const generator = new DocumentGenerator();
    const output = generator.generateRulesYaml([
      {
        ruleType: "validation",
        name: 'order:status #1',
        description: 'Line one\nLine "two"\n- dash',
        condition: 'status == "ready": keep #tag',
        sourceFile: "src/orders.go",
        lineNumber: 42,
      },
    ]);

    expect(output).toContain('name: "order:status #1"');
    expect(output).toContain('description: "Line one\\nLine \\"two\\"\\n- dash"');
    expect(output).toContain('condition: "status == \\"ready\\": keep #tag"');
    expect(output).toContain('source: "src/orders.go:42"');
  });

  it("emits a compact empty YAML document when no rules were found", () => {
    const generator = new DocumentGenerator();
    expect(generator.generateRulesYaml([])).toBe("rules: []");
  });

  it("adds review-scope disclaimers to generated markdown artifacts", () => {
    const generator = new DocumentGenerator();

    expect(generator.generateFlowDocument([], [])).toContain("legacy impact review assistant");
    expect(generator.generateDataDependencyDocument([])).toContain("dynamic SQL");
    expect(generator.generateRisksDocument([])).toContain("validated by a human reviewer");
  });

  it("generates Delphi event and DB binding reports", () => {
    const generator = new DocumentGenerator();

    expect(
      generator.generateDelphiEventMapDocument([
        {
          formName: "Form1",
          componentName: "Button1",
          componentClass: "TButton",
          eventName: "OnClick",
          handlerName: "Button1Click",
          filePath: "Form1.dfm",
          lineNumber: 3,
          resolvedMethod: "TForm1.Button1Click",
          resolvedFile: "Form1.pas",
          status: "resolved",
          warnings: [],
        },
      ])
    ).toContain("TForm1.Button1Click");

    const dataBindings = generator.generateDelphiDataBindingsDocument([
      {
        formName: "CustomerForm",
        componentName: "DBEdit1",
        componentClass: "TDBEdit",
        dataSource: "dsMaster",
        dataSet: "cdsMaster",
        dataField: "CUST_NAME",
        readOnly: false,
        enabled: true,
        visible: true,
        accessHint: "read-write",
        confidence: "high",
        sourceFile: "CustomerForm.dfm",
        lineNumber: 9,
        warnings: [],
      },
    ]);

    expect(dataBindings).toContain("DB-aware UI components");
    expect(dataBindings).toContain("CUST_NAME");
  });
});
