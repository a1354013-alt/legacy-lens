/**
 * Legacy Lens - 風險檢測引擎
 * 識別程式碼中的潛在風險和問題
 */

export interface Risk {
  id?: number;
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string; // "magic_value" | "multiple_writes" | "missing_condition" | "format_conversion" | etc.
  sourceFile: string;
  lineNumber: number;
  suggestion?: string;
}

export class RiskDetector {
  /**
   * 檢測魔法值風險
   * 魔法值是硬編碼的常數，缺乏上下文說明
   */
  detectMagicValues(
    magicValues: Array<{ value: string; type: string; file: string; line: number; context: string }>
  ): Risk[] {
    const risks: Risk[] = [];

    magicValues.forEach((mv) => {
      // 過濾掉明顯的常數（如 0, 1, 100）
      if (["0", "1", "100", "-1"].includes(mv.value)) return;

      // 檢測日期格式的魔法值
      if (/^\d{4}-\d{2}-\d{2}$/.test(mv.value) || /^\d{8}$/.test(mv.value)) {
        risks.push({
          title: "日期格式魔法值",
          description: `發現硬編碼的日期值 "${mv.value}"。建議使用常數或配置文件定義。`,
          severity: "medium",
          category: "magic_value",
          sourceFile: mv.file,
          lineNumber: mv.line,
          suggestion: `將 "${mv.value}" 提取為命名常數，例如：const DEFAULT_DATE = "${mv.value}"`,
        });
      }

      // 檢測長字串的魔法值
      if (mv.type === "string" && mv.value.length > 10) {
        risks.push({
          title: "長字串魔法值",
          description: `發現硬編碼的長字串 "${mv.value.substring(0, 30)}..."。建議使用常數或配置。`,
          severity: "low",
          category: "magic_value",
          sourceFile: mv.file,
          lineNumber: mv.line,
        });
      }

      // 檢測數字魔法值（年份、金額等）
      if (mv.type === "number" && mv.value.length >= 4) {
        risks.push({
          title: "數字魔法值",
          description: `發現硬編碼的數字 "${mv.value}"。可能是年份、金額或其他業務常數。`,
          severity: "medium",
          category: "magic_value",
          sourceFile: mv.file,
          lineNumber: mv.line,
        });
      }
    });

    return risks;
  }

  /**
   * 檢測多處寫入同欄位的風險
   */
  detectMultipleWrites(
    fieldReferences: Array<{
      field: string;
      table: string;
      type: "read" | "write" | "calculate";
      file: string;
      line: number;
    }>
  ): Risk[] {
    const risks: Risk[] = [];

    // 統計每個欄位的寫入次數
    const writeCount: Record<string, Array<{ file: string; line: number }>> = {};

    fieldReferences.forEach((ref) => {
      if (ref.type === "write") {
        const key = `${ref.table}.${ref.field}`;
        if (!writeCount[key]) {
          writeCount[key] = [];
        }
        writeCount[key].push({ file: ref.file, line: ref.line });
      }
    });

    // 找出多處寫入的欄位
    Object.entries(writeCount).forEach(([fieldKey, writes]) => {
      if (writes.length > 1) {
        const locations = writes.map((w) => `${w.file}:${w.line}`).join("、");
        risks.push({
          title: `欄位 "${fieldKey}" 多處寫入`,
          description: `欄位 "${fieldKey}" 在多個地方被寫入（${writes.length} 次）。可能導致資料一致性問題。`,
          severity: "high",
          category: "multiple_writes",
          sourceFile: writes[0].file,
          lineNumber: writes[0].line,
          suggestion: `檢查所有寫入位置的邏輯是否一致：${locations}`,
        });
      }
    });

    return risks;
  }

  /**
   * 檢測 SQL 缺少 WHERE 條件的風險
   */
  detectMissingConditions(
    dangerousQueries: Array<{ type: string; line: number; query: string; file: string }>
  ): Risk[] {
    const risks: Risk[] = [];

    dangerousQueries.forEach((query) => {
      if (query.type === "missing_where") {
        risks.push({
          title: "SQL 缺少 WHERE 條件",
          description: `SQL 語句缺少 WHERE 條件，可能導致誤刪除或誤更新全表數據。`,
          severity: "critical",
          category: "missing_condition",
          sourceFile: query.file,
          lineNumber: query.line,
          suggestion: `添加 WHERE 條件以限制操作範圍。原語句：${query.query}`,
        });
      }
    });

    return risks;
  }

  /**
   * 檢測日期/金額格式轉換風險
   */
  detectFormatConversionRisks(content: string, file: string): Risk[] {
    const risks: Risk[] = [];
    const lines = content.split("\n");

    // 檢測日期轉換
    const datePatterns = [
      { regex: /strconv\.Parse.*Date|time\.Parse|ParseTime/i, issue: "日期解析" },
      { regex: /format.*Date|strftime|FormatDate/i, issue: "日期格式化" },
    ];

    // 檢測金額轉換
    const amountPatterns = [
      { regex: /strconv\.Parse.*Float|ParseFloat|ToDecimal/i, issue: "金額解析" },
      { regex: /Round\(|Truncate\(|FormatMoney/i, issue: "金額四捨五入" },
    ];

    lines.forEach((line, index) => {
      // 檢測日期轉換
      datePatterns.forEach((pattern) => {
        if (pattern.regex.test(line)) {
          risks.push({
            title: `日期轉換風險：${pattern.issue}`,
            description: `檢測到 ${pattern.issue} 操作。需要驗證時區、格式和邊界情況。`,
            severity: "medium",
            category: "format_conversion",
            sourceFile: file,
            lineNumber: index + 1,
            suggestion: `確保所有日期操作都明確指定時區和格式。`,
          });
        }
      });

      // 檢測金額轉換
      amountPatterns.forEach((pattern) => {
        if (pattern.regex.test(line)) {
          risks.push({
            title: `金額轉換風險：${pattern.issue}`,
            description: `檢測到 ${pattern.issue} 操作。需要驗證精度和四捨五入規則。`,
            severity: "high",
            category: "format_conversion",
            sourceFile: file,
            lineNumber: index + 1,
            suggestion: `使用固定精度的數據類型（如 Decimal），避免浮點數精度問題。`,
          });
        }
      });
    });

    return risks;
  }

  /**
   * 檢測狀態轉換風險
   */
  detectStateTransitionRisks(content: string, file: string): Risk[] {
    const risks: Risk[] = [];
    const lines = content.split("\n");

    // 檢測狀態標誌（Status、State、Flag 等）
    const statePatterns = [
      { regex: /Status\s*=|State\s*=|Flag\s*=/i, issue: "狀態轉換" },
      { regex: /switch.*Status|switch.*State|switch.*Flag/i, issue: "狀態判斷" },
    ];

    lines.forEach((line, index) => {
      statePatterns.forEach((pattern) => {
        if (pattern.regex.test(line)) {
          risks.push({
            title: `狀態轉換風險：${pattern.issue}`,
            description: `檢測到 ${pattern.issue} 操作。需要驗證所有可能的狀態轉換路徑。`,
            severity: "medium",
            category: "state_transition",
            sourceFile: file,
            lineNumber: index + 1,
            suggestion: `確保狀態轉換遵循業務規則，並記錄所有狀態變更。`,
          });
        }
      });
    });

    return risks;
  }

  /**
   * 檢測並發/鎖定風險
   */
  detectConcurrencyRisks(content: string, file: string): Risk[] {
    const risks: Risk[] = [];
    const lines = content.split("\n");

    // 檢測並發相關操作
    const concurrencyPatterns = [
      { regex: /mutex|Mutex|Lock|lock/i, issue: "互斥鎖" },
      { regex: /transaction|Transaction|BEGIN|COMMIT|ROLLBACK/i, issue: "事務" },
      { regex: /goroutine|go\s+func|channel|Channel/i, issue: "並發" },
    ];

    lines.forEach((line, index) => {
      concurrencyPatterns.forEach((pattern) => {
        if (pattern.regex.test(line)) {
          risks.push({
            title: `並發風險：${pattern.issue}`,
            description: `檢測到 ${pattern.issue} 操作。需要驗證並發安全性。`,
            severity: "high",
            category: "concurrency",
            sourceFile: file,
            lineNumber: index + 1,
            suggestion: `確保所有共享資源都被正確保護，避免競態條件。`,
          });
        }
      });
    });

    return risks;
  }

  /**
   * 綜合風險評分
   */
  calculateRiskScore(risks: Risk[]): number {
    const weights = {
      critical: 100,
      high: 50,
      medium: 20,
      low: 5,
    };

    return risks.reduce((score, risk) => score + weights[risk.severity], 0);
  }
}
