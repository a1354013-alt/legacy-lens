import { describe, expect, it } from "vitest";
import {
  analysisStatusLabel,
  analysisEntityTypeLabel,
  buildDoctorStatusLabel,
  confidenceLevelLabel,
  fieldOperationLabel,
  findingSeverityLabel,
  flowStatusLabel,
  localizeProjectJobErrorMessage,
  packageResolutionLabel,
  projectJobFailureTitle,
  riskTypeLabel,
} from "./uiLabels";

describe("project job error labels", () => {
  it("localizes every persisted analysis status, including completed_with_warnings", () => {
    expect(analysisStatusLabel("pending")).toBe("尚未分析");
    expect(analysisStatusLabel("processing")).toBe("分析中");
    expect(analysisStatusLabel("completed")).toBe("分析完成");
    expect(analysisStatusLabel("completed_with_warnings")).toBe("分析完成（含警告）");
    expect(analysisStatusLabel("partial")).toBe("部分完成");
    expect(analysisStatusLabel("failed")).toBe("分析失敗");
  });

  it("shows analysis failure labels for analyze jobs", () => {
    expect(projectJobFailureTitle("analyze")).toBe("分析失敗");
    expect(localizeProjectJobErrorMessage("analyze", "Analysis failed.")).toBe("分析失敗，請查看分析紀錄或伺服器日誌。");
  });

  it("keeps import failure labels for import jobs", () => {
    expect(projectJobFailureTitle("import_zip")).toBe("匯入失敗");
    expect(localizeProjectJobErrorMessage("import_zip", "Import failed.")).toBe("匯入工作失敗。");
  });
});

describe("localized UI enum labels", () => {
  it("covers analysis result enum families without returning raw keys", () => {
    const values = [
      ["read", fieldOperationLabel("read")],
      ["write", fieldOperationLabel("write")],
      ["calculate", fieldOperationLabel("calculate")],
      ["unknown", fieldOperationLabel("unknown")],
      ["high", confidenceLevelLabel("high")],
      ["medium", confidenceLevelLabel("medium")],
      ["low", confidenceLevelLabel("low")],
      ["complete", flowStatusLabel("complete")],
      ["partial", flowStatusLabel("partial")],
      ["unresolved", flowStatusLabel("unresolved")],
      ["not_applicable", buildDoctorStatusLabel("not_applicable")],
      ["ready", buildDoctorStatusLabel("ready")],
      ["ready_with_warnings", buildDoctorStatusLabel("ready_with_warnings")],
      ["blocked", buildDoctorStatusLabel("blocked")],
      ["project_local", packageResolutionLabel("project_local")],
      ["delphi_standard", packageResolutionLabel("delphi_standard")],
      ["external_unverified", packageResolutionLabel("external_unverified")],
      ["missing", packageResolutionLabel("missing")],
      ["ambiguous", packageResolutionLabel("ambiguous")],
      ["critical", findingSeverityLabel("critical")],
      ["error", findingSeverityLabel("error")],
      ["warning", findingSeverityLabel("warning")],
      ["info", findingSeverityLabel("info")],
      ["ui_component", analysisEntityTypeLabel("ui_component")],
      ["data_binding", analysisEntityTypeLabel("data_binding")],
      ["event", analysisEntityTypeLabel("event")],
      ["handler", analysisEntityTypeLabel("handler")],
      ["method", analysisEntityTypeLabel("method")],
      ["call", analysisEntityTypeLabel("call")],
      ["sql", analysisEntityTypeLabel("sql")],
      ["table", analysisEntityTypeLabel("table")],
      ["field", analysisEntityTypeLabel("field")],
      ["warning_step", analysisEntityTypeLabel("warning_step")],
      ["magic_value", riskTypeLabel("magic_value")],
      ["multiple_writes", riskTypeLabel("multiple_writes")],
      ["missing_condition", riskTypeLabel("missing_condition")],
      ["format_conversion", riskTypeLabel("format_conversion")],
      ["inconsistent_logic", riskTypeLabel("inconsistent_logic")],
      ["other", riskTypeLabel("other")],
    ];

    for (const [raw, label] of values) {
      expect(label).not.toBe(raw);
      expect(label).not.toMatch(/^labels\./);
    }
  });

  it("returns Traditional Chinese package resolution labels", () => {
    expect(packageResolutionLabel("project_local")).toBe("專案內套件");
    expect(packageResolutionLabel("delphi_standard")).toBe("Delphi 標準套件");
    expect(packageResolutionLabel("external_unverified")).toBe("外部套件，待確認");
    expect(packageResolutionLabel("missing")).toBe("缺少");
    expect(packageResolutionLabel("ambiguous")).toBe("解析不明確");
  });
});
