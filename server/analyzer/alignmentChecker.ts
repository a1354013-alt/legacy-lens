/**
 * 差異對齊檢查引擎
 * 用於對比舊系統（Delphi）與新系統（Go API）的流程差異
 */

export interface ProcessStep {
  id: string;
  name: string;
  description: string;
  inputs: string[];
  outputs: string[];
  validations: string[];
  errorHandling: string[];
  file?: string;
  line?: number;
}

export interface AlignmentGap {
  id: string;
  oldStep: ProcessStep | null;
  newStep: ProcessStep | null;
  gapType: "missing_in_new" | "missing_in_old" | "logic_difference" | "data_mismatch";
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  recommendation: string;
  affectedFields?: string[];
}

export interface AlignmentReport {
  totalSteps: number;
  alignedSteps: number;
  gaps: AlignmentGap[];
  overallAlignment: number; // 0-100
  riskScore: number; // 0-100
  summary: string;
}

/**
 * 提取 Delphi 程式碼中的流程步驟
 */
export function extractDelphiProcesses(code: string): ProcessStep[] {
  const steps: ProcessStep[] = [];
  const lines = code.split("\n");

  // 正則表達式用於識別 Delphi 程序
  const procPattern = /procedure\s+(\w+)\s*\(/gi;
  const functionPattern = /function\s+(\w+)\s*\(/gi;

  let match;
  const procRegex = /procedure\s+(\w+)\s*\(/gi;
  while ((match = procRegex.exec(code)) !== null) {
    const procName = match[1];
    const lineNum = code.substring(0, match.index).split("\n").length;

    steps.push({
      id: `delphi_${procName}_${lineNum}`,
      name: procName,
      description: `Delphi procedure: ${procName}`,
      inputs: extractDelphiInputs(code, procName),
      outputs: extractDelphiOutputs(code, procName),
      validations: extractDelphiValidations(code, procName),
      errorHandling: extractDelphiErrorHandling(code, procName),
      file: "unknown",
      line: lineNum,
    });
  }

  return steps;
}

/**
 * 提取 Go API 中的流程步驟
 */
export function extractGoProcesses(code: string): ProcessStep[] {
  const steps: ProcessStep[] = [];

  // 正則表達式用於識別 Go 函數
  const funcPattern = /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/g;

  let match;
  while ((match = funcPattern.exec(code)) !== null) {
    const funcName = match[1];
    const lineNum = code.substring(0, match.index).split("\n").length;

    steps.push({
      id: `go_${funcName}_${lineNum}`,
      name: funcName,
      description: `Go function: ${funcName}`,
      inputs: extractGoInputs(code, funcName),
      outputs: extractGoOutputs(code, funcName),
      validations: extractGoValidations(code, funcName),
      errorHandling: extractGoErrorHandling(code, funcName),
      file: "unknown",
      line: lineNum,
    });
  }

  return steps;
}

/**
 * 提取 Delphi 程序的輸入參數
 */
function extractDelphiInputs(code: string, procName: string): string[] {
  const procPattern = new RegExp(
    `procedure\\s+${procName}\\s*\\(([^)]*)\\)`,
    "i"
  );
  const match = code.match(procPattern);
  if (!match || !match[1]) return [];

  return match[1]
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !p.toLowerCase().startsWith("var"))
    .map((p) => p.split(":")[0].trim());
}

/**
 * 提取 Delphi 程序的輸出（var 參數）
 */
function extractDelphiOutputs(code: string, procName: string): string[] {
  const procPattern = new RegExp(
    `procedure\\s+${procName}\\s*\\(([^)]*)\\)`,
    "i"
  );
  const match = code.match(procPattern);
  if (!match || !match[1]) return [];

  return match[1]
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.toLowerCase().startsWith("var"))
    .map((p) => p.replace(/^var\s+/i, "").split(":")[0].trim());
}

/**
 * 提取 Delphi 程序中的驗證邏輯
 */
function extractDelphiValidations(code: string, procName: string): string[] {
  const validations: string[] = [];
  const procStart = code.indexOf(`procedure ${procName}`);
  const procEnd = code.indexOf("end;", procStart);

  if (procStart === -1 || procEnd === -1) return validations;

  const procCode = code.substring(procStart, procEnd);

  // 尋找 if 語句（驗證）
  const ifPattern = /if\s+([^then]+)\s+then/gi;
  let match;
  while ((match = ifPattern.exec(procCode)) !== null) {
    validations.push(match[1].trim());
  }

  return validations;
}

/**
 * 提取 Delphi 程序中的錯誤處理
 */
function extractDelphiErrorHandling(code: string, procName: string): string[] {
  const errorHandling: string[] = [];
  const procStart = code.indexOf(`procedure ${procName}`);
  const procEnd = code.indexOf("end;", procStart);

  if (procStart === -1 || procEnd === -1) return errorHandling;

  const procCode = code.substring(procStart, procEnd);

  // 尋找 try-except 塊
  if (procCode.includes("try")) {
    errorHandling.push("try-except");
  }

  // 尋找 raise 語句
  const raisePattern = /raise\s+(\w+)/gi;
  let match;
  while ((match = raisePattern.exec(procCode)) !== null) {
    errorHandling.push(`raise ${match[1]}`);
  }

  return errorHandling;
}

/**
 * 提取 Go 函數的輸入參數
 */
function extractGoInputs(code: string, funcName: string): string[] {
  const funcPattern = new RegExp(
    `func\\s+(?:\\(\\w+\\s+\\*?\\w+\\)\\s+)?${funcName}\\s*\\(([^)]*)\\)`,
    "i"
  );
  const match = code.match(funcPattern);
  if (!match || !match[1]) return [];

  return match[1]
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p)
    .map((p) => p.split(" ")[0].trim());
}

/**
 * 提取 Go 函數的輸出（返回值）
 */
function extractGoOutputs(code: string, funcName: string): string[] {
  const funcPattern = new RegExp(
    `func\\s+(?:\\(\\w+\\s+\\*?\\w+\\)\\s+)?${funcName}\\s*\\([^)]*\\)\\s*\\(([^)]*)\\)`,
    "i"
  );
  const match = code.match(funcPattern);
  if (!match || !match[1]) return [];

  return match[1]
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p)
    .map((p) => p.split(" ")[0].trim());
}

/**
 * 提取 Go 函數中的驗證邏輯
 */
function extractGoValidations(code: string, funcName: string): string[] {
  const validations: string[] = [];
  const funcStart = code.indexOf(`func ${funcName}`);
  const funcEnd = code.indexOf("\n}\n", funcStart);

  if (funcStart === -1) return validations;

  const funcCode = code.substring(funcStart, funcEnd === -1 ? undefined : funcEnd);

  // 尋找 if 語句（驗證）
  const ifPattern = /if\s+([^{]+)\s*{/gi;
  let match;
  while ((match = ifPattern.exec(funcCode)) !== null) {
    validations.push(match[1].trim());
  }

  return validations;
}

/**
 * 提取 Go 函數中的錯誤處理
 */
function extractGoErrorHandling(code: string, funcName: string): string[] {
  const errorHandling: string[] = [];
  const funcStart = code.indexOf(`func ${funcName}`);
  const funcEnd = code.indexOf("\n}\n", funcStart);

  if (funcStart === -1) return errorHandling;

  const funcCode = code.substring(funcStart, funcEnd === -1 ? undefined : funcEnd);

  // 尋找 if err != nil
  if (funcCode.includes("if err != nil")) {
    errorHandling.push("if err != nil");
  }

  // 尋找 panic
  if (funcCode.includes("panic")) {
    errorHandling.push("panic");
  }

  // 尋找 return err
  if (funcCode.includes("return err")) {
    errorHandling.push("return err");
  }

  return errorHandling;
}

/**
 * 對比兩個流程步驟列表並生成對齊報告
 */
export function generateAlignmentReport(
  oldSteps: ProcessStep[],
  newSteps: ProcessStep[]
): AlignmentReport {
  const gaps: AlignmentGap[] = [];
  const alignedSteps: Set<string> = new Set();

  // 檢查舊系統中的步驟是否在新系統中
  for (const oldStep of oldSteps) {
    const matchingNewStep = findMatchingStep(oldStep, newSteps);

    if (!matchingNewStep) {
      gaps.push({
        id: `gap_${oldStep.id}`,
        oldStep,
        newStep: null,
        gapType: "missing_in_new",
        severity: "high",
        description: `舊系統中的步驟 "${oldStep.name}" 在新系統中未找到對應實現`,
        recommendation: `需要在新系統中實現 "${oldStep.name}" 的功能，或確認該功能已被其他步驟替代`,
        affectedFields: oldStep.outputs,
      });
    } else {
      alignedSteps.add(matchingNewStep.id);

      // 檢查邏輯差異
      const logicDifferences = compareStepLogic(oldStep, matchingNewStep);
      if (logicDifferences.length > 0) {
        gaps.push({
          id: `gap_${oldStep.id}_logic`,
          oldStep,
          newStep: matchingNewStep,
          gapType: "logic_difference",
          severity: "medium",
          description: `步驟 "${oldStep.name}" 的邏輯實現存在差異`,
          recommendation: `需要驗證新系統的實現是否符合舊系統的業務邏輯`,
          affectedFields: logicDifferences,
        });
      }
    }
  }

  // 檢查新系統中是否有舊系統沒有的步驟
  for (const newStep of newSteps) {
    if (!alignedSteps.has(newStep.id)) {
      const hasOldEquivalent = oldSteps.some((s) => findMatchingStep(s, [newStep]));
      if (!hasOldEquivalent) {
        gaps.push({
          id: `gap_${newStep.id}`,
          oldStep: null,
          newStep,
          gapType: "missing_in_old",
          severity: "low",
          description: `新系統中的步驟 "${newStep.name}" 在舊系統中沒有對應實現`,
          recommendation: `這可能是新功能或改進，需要確認是否符合業務需求`,
        });
      }
    }
  }

  const overallAlignment = Math.round(
    ((oldSteps.length - gaps.filter((g) => g.gapType === "missing_in_new").length) /
      oldSteps.length) *
      100
  );

  const riskScore = Math.round(
    (gaps.filter((g) => g.severity === "critical").length * 40 +
      gaps.filter((g) => g.severity === "high").length * 20 +
      gaps.filter((g) => g.severity === "medium").length * 10) /
      Math.max(oldSteps.length, newSteps.length)
  );

  return {
    totalSteps: Math.max(oldSteps.length, newSteps.length),
    alignedSteps: alignedSteps.size,
    gaps,
    overallAlignment,
    riskScore,
    summary: generateSummary(gaps, overallAlignment, riskScore),
  };
}

/**
 * 尋找匹配的步驟
 */
function findMatchingStep(
  step: ProcessStep,
  candidates: ProcessStep[]
): ProcessStep | null {
  // 首先嘗試名稱匹配
  const nameMatch = candidates.find(
    (c) =>
      c.name.toLowerCase().includes(step.name.toLowerCase()) ||
      step.name.toLowerCase().includes(c.name.toLowerCase())
  );

  if (nameMatch) return nameMatch;

  // 其次嘗試輸入輸出匹配
  const ioMatch = candidates.find(
    (c) =>
      step.inputs.some((i) => c.inputs.includes(i)) &&
      step.outputs.some((o) => c.outputs.includes(o))
  );

  return ioMatch || null;
}

/**
 * 對比步驟邏輯
 */
function compareStepLogic(step1: ProcessStep, step2: ProcessStep): string[] {
  const differences: string[] = [];

  // 比較輸入
  const missingInputs = step1.inputs.filter((i) => !step2.inputs.includes(i));
  if (missingInputs.length > 0) {
    differences.push(`缺少輸入: ${missingInputs.join(", ")}`);
  }

  // 比較輸出
  const missingOutputs = step1.outputs.filter((o) => !step2.outputs.includes(o));
  if (missingOutputs.length > 0) {
    differences.push(`缺少輸出: ${missingOutputs.join(", ")}`);
  }

  // 比較驗證
  const missingValidations = step1.validations.filter(
    (v) => !step2.validations.some((v2) => v2.includes(v.split(" ")[0]))
  );
  if (missingValidations.length > 0) {
    differences.push(`驗證差異: ${missingValidations.length} 個`);
  }

  // 比較錯誤處理
  if (step1.errorHandling.length > 0 && step2.errorHandling.length === 0) {
    differences.push("缺少錯誤處理");
  }

  return differences;
}

/**
 * 生成摘要
 */
function generateSummary(gaps: AlignmentGap[], alignment: number, riskScore: number): string {
  const criticalGaps = gaps.filter((g) => g.severity === "critical").length;
  const highGaps = gaps.filter((g) => g.severity === "high").length;

  let summary = `對齊度: ${alignment}% | 風險評分: ${riskScore}/100\n`;

  if (criticalGaps > 0) {
    summary += `⚠️ 發現 ${criticalGaps} 個關鍵差異，需要立即處理\n`;
  }

  if (highGaps > 0) {
    summary += `⚠️ 發現 ${highGaps} 個高風險差異，建議優先處理\n`;
  }

  if (alignment >= 90) {
    summary += "✅ 系統對齊度良好，可以進行遷移";
  } else if (alignment >= 70) {
    summary += "⚠️ 系統對齊度一般，建議補充缺失功能後再遷移";
  } else {
    summary += "❌ 系統對齊度較低，建議進行詳細分析和補充";
  }

  return summary;
}
