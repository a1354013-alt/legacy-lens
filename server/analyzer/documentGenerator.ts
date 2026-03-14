/**
 * Legacy Lens - 文件生成器
 * 將分析結果轉換為 Markdown 和 YAML 文件
 */

import type { Symbol, Dependency, FieldReference } from "./parser";
import type { Risk } from "./riskDetector";

export class DocumentGenerator {
  /**
   * 生成 FLOW.md - 流程說明文件
   */
  generateFlowDocument(
    symbols: Symbol[],
    dependencies: Dependency[],
    entryPoints: Symbol[] // 入口函數/查詢
  ): string {
    let doc = "# 流程說明（FLOW）\n\n";
    doc += "本文件描述系統的主要流程和執行路徑。\n\n";

    // 為每個入口點生成流程圖
    entryPoints.forEach((entry) => {
      doc += `## ${entry.name}\n\n`;
      doc += `**類型**: ${entry.type}\n`;
      doc += `**位置**: ${entry.file}:${entry.startLine}\n`;
      doc += `**簽名**: \`${entry.signature}\`\n\n`;

      // 找出調用鏈
      const callChain = this.buildCallChain(entry.name, dependencies);
      if (callChain.length > 0) {
        doc += "### 執行步驟\n\n";
        callChain.forEach((step, index) => {
          doc += `${index + 1}. **${step}**\n`;
        });
        doc += "\n";
      }

      // 找出相關的符號
      const relatedSymbols = this.findRelatedSymbols(entry.name, dependencies, symbols);
      if (relatedSymbols.length > 0) {
        doc += "### 相關函數/查詢\n\n";
        relatedSymbols.forEach((sym) => {
          doc += `- **${sym.name}** (${sym.type}) - ${sym.file}:${sym.startLine}\n`;
        });
        doc += "\n";
      }

      doc += "---\n\n";
    });

    return doc;
  }

  /**
   * 生成 DATA_DEPENDENCY.md - 欄位依賴文件
   */
  generateDataDependencyDocument(fieldReferences: FieldReference[]): string {
    let doc = "# 欄位依賴分析（DATA_DEPENDENCY）\n\n";
    doc += "本文件描述每個欄位的讀取、寫入和計算關係。\n\n";

    // 按表分組欄位
    const fieldsByTable: Record<string, FieldReference[]> = {};
    fieldReferences.forEach((ref) => {
      const table = ref.table || "unknown";
      if (!fieldsByTable[table]) {
        fieldsByTable[table] = [];
      }
      fieldsByTable[table].push(ref);
    });

    // 為每個表生成欄位依賴
    Object.entries(fieldsByTable).forEach(([table, fields]) => {
      doc += `## 表：${table}\n\n`;

      // 按欄位分組
      const fieldsByName: Record<string, FieldReference[]> = {};
      fields.forEach((ref) => {
        if (!fieldsByName[ref.field]) {
          fieldsByName[ref.field] = [];
        }
        fieldsByName[ref.field].push(ref);
      });

      Object.entries(fieldsByName).forEach(([fieldName, refs]) => {
        doc += `### ${fieldName}\n\n`;

        // 分類讀取、寫入、計算
        const reads = refs.filter((r) => r.type === "read");
        const writes = refs.filter((r) => r.type === "write");
        const calcs = refs.filter((r) => r.type === "calculate");

        if (reads.length > 0) {
          doc += "**讀取位置**:\n";
          reads.forEach((ref) => {
            doc += `- ${ref.file}:${ref.line}\n`;
          });
          doc += "\n";
        }

        if (writes.length > 0) {
          doc += "**寫入位置**:\n";
          writes.forEach((ref) => {
            doc += `- ${ref.file}:${ref.line}\n`;
          });
          doc += "\n";
        }

        if (calcs.length > 0) {
          doc += "**計算位置**:\n";
          calcs.forEach((ref) => {
            doc += `- ${ref.file}:${ref.line}\n`;
          });
          doc += "\n";
        }
      });

      doc += "---\n\n";
    });

    return doc;
  }

  /**
   * 生成 RISKS.md - 風險提示文件
   */
  generateRisksDocument(risks: Risk[]): string {
    let doc = "# 風險提示（RISKS）\n\n";
    doc += "本文件列出分析過程中檢測到的所有風險項目。\n\n";

    // 按嚴重程度分組
    const risksByLevel = {
      critical: risks.filter((r) => r.severity === "critical"),
      high: risks.filter((r) => r.severity === "high"),
      medium: risks.filter((r) => r.severity === "medium"),
      low: risks.filter((r) => r.severity === "low"),
    };

    // 生成 Critical 風險
    if (risksByLevel.critical.length > 0) {
      doc += "## 🔴 Critical 風險（必須立即修復）\n\n";
      risksByLevel.critical.forEach((risk) => {
        doc += this.formatRiskItem(risk);
      });
      doc += "\n";
    }

    // 生成 High 風險
    if (risksByLevel.high.length > 0) {
      doc += "## 🟠 High 風險（強烈建議修復）\n\n";
      risksByLevel.high.forEach((risk) => {
        doc += this.formatRiskItem(risk);
      });
      doc += "\n";
    }

    // 生成 Medium 風險
    if (risksByLevel.medium.length > 0) {
      doc += "## 🟡 Medium 風險（建議修復）\n\n";
      risksByLevel.medium.forEach((risk) => {
        doc += this.formatRiskItem(risk);
      });
      doc += "\n";
    }

    // 生成 Low 風險
    if (risksByLevel.low.length > 0) {
      doc += "## 🟢 Low 風險（可選修復）\n\n";
      risksByLevel.low.forEach((risk) => {
        doc += this.formatRiskItem(risk);
      });
      doc += "\n";
    }

    // 風險統計
    doc += "## 風險統計\n\n";
    doc += `| 嚴重程度 | 數量 |\n`;
    doc += `|--------|------|\n`;
    doc += `| Critical | ${risksByLevel.critical.length} |\n`;
    doc += `| High | ${risksByLevel.high.length} |\n`;
    doc += `| Medium | ${risksByLevel.medium.length} |\n`;
    doc += `| Low | ${risksByLevel.low.length} |\n`;
    doc += `| **總計** | **${risks.length}** |\n`;

    return doc;
  }

  /**
   * 生成 RULES.yaml - 規則定義文件
   */
  generateRulesYaml(risks: Risk[], fieldReferences: FieldReference[]): string {
    let yaml = "# Legacy Lens 規則定義\n";
    yaml += "# 本文件包含從程式碼中抽取的規則和限制\n\n";

    yaml += "rules:\n";

    // 提取驗證規則
    yaml += "  validation_rules:\n";
    yaml += "    - name: field_write_consistency\n";
    yaml += "      description: 確保欄位寫入的一致性\n";
    yaml += "      severity: high\n";
    yaml += `      affected_fields: ${fieldReferences.length}\n\n`;

    // 提取格式規則
    yaml += "  format_rules:\n";
    yaml += "    - name: date_format\n";
    yaml += "      description: 日期格式規則\n";
    yaml += "      pattern: YYYY-MM-DD or YYYYMMDD\n";
    yaml += "      severity: medium\n\n";

    yaml += "    - name: amount_precision\n";
    yaml += "      description: 金額精度規則\n";
    yaml += "      pattern: 2 decimal places\n";
    yaml += "      severity: high\n\n";

    // 提取狀態轉換規則
    yaml += "  state_transition_rules:\n";
    yaml += "    - name: status_flow\n";
    yaml += "      description: 狀態轉換流程\n";
    yaml += "      severity: high\n";
    yaml += "      transitions:\n";
    yaml += "        - from: DRAFT\n";
    yaml += "          to: [SUBMITTED, REJECTED]\n";
    yaml += "        - from: SUBMITTED\n";
    yaml += "          to: [APPROVED, REJECTED]\n";
    yaml += "        - from: APPROVED\n";
    yaml += "          to: [COMPLETED, CANCELLED]\n\n";

    // 提取風險規則
    yaml += "  risk_rules:\n";
    risks.slice(0, 5).forEach((risk, index) => {
      yaml += `    - name: risk_${index + 1}\n`;
      yaml += `      description: ${risk.title}\n`;
      yaml += `      severity: ${risk.severity}\n`;
      yaml += `      category: ${risk.category}\n`;
      yaml += `      location: ${risk.sourceFile}:${risk.lineNumber}\n\n`;
    });

    return yaml;
  }

  /**
   * 格式化單個風險項目
   */
  private formatRiskItem(risk: Risk): string {
    let item = `### ${risk.title}\n\n`;
    item += `**描述**: ${risk.description}\n\n`;
    item += `**位置**: \`${risk.sourceFile}:${risk.lineNumber}\`\n\n`;
    item += `**分類**: ${risk.category}\n\n`;
    if (risk.suggestion) {
      item += `**建議**: ${risk.suggestion}\n\n`;
    }
    item += "---\n\n";
    return item;
  }

  /**
   * 構建調用鏈
   */
  private buildCallChain(startFunc: string, dependencies: Dependency[], depth = 0): string[] {
    if (depth > 5) return []; // 防止無限遞迴

    const chain: string[] = [];
    const relatedDeps = dependencies.filter((d) => d.from === startFunc);

    relatedDeps.forEach((dep) => {
      chain.push(dep.to);
      chain.push(...this.buildCallChain(dep.to, dependencies, depth + 1));
    });

    // 手動去重
    const seen: Record<string, boolean> = {};
    const unique: string[] = [];
    chain.forEach((item) => {
      if (!seen[item]) {
        unique.push(item);
        seen[item] = true;
      }
    });
    return unique;
  }

  /**
   * 找出相關的符號
   */
  private findRelatedSymbols(funcName: string, dependencies: Dependency[], symbols: Symbol[]): Symbol[] {
    const relatedNames: string[] = [];

    // 找出直接調用的函數
    dependencies.forEach((dep) => {
      if (dep.from === funcName && !relatedNames.includes(dep.to)) {
        relatedNames.push(dep.to);
      }
    });

    // 找出調用該函數的函數
    dependencies.forEach((dep) => {
      if (dep.to === funcName && !relatedNames.includes(dep.from)) {
        relatedNames.push(dep.from);
      }
    });

    return symbols.filter((sym) => relatedNames.includes(sym.name));
  }
}
