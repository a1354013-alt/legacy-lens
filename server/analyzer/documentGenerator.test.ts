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
});
