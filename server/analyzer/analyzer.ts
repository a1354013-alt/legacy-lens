/**
 * Legacy Lens - 分析協調器
 * 統一協調整個分析流程
 */

import { GoParser, SQLParser, ParserFactory, type Symbol, type Dependency, type FieldReference } from "./parser";
import { RiskDetector, type Risk } from "./riskDetector";
import { DocumentGenerator } from "./documentGenerator";

export interface AnalysisResult {
  projectId: number;
  language: string;
  symbols: Symbol[];
  dependencies: Dependency[];
  fieldReferences: FieldReference[];
  risks: Risk[];
  flowDocument: string;
  dataDependencyDocument: string;
  risksDocument: string;
  rulesYaml: string;
  riskScore: number;
}

export class Analyzer {
  private riskDetector: RiskDetector;
  private documentGenerator: DocumentGenerator;

  constructor() {
    this.riskDetector = new RiskDetector();
    this.documentGenerator = new DocumentGenerator();
  }

  /**
   * 分析單個檔案
   */
  async analyzeFile(content: string, filePath: string, language: string): Promise<{
    symbols: Symbol[];
    dependencies: Dependency[];
    fieldReferences: FieldReference[];
    risks: Risk[];
  }> {
    const symbols: Symbol[] = [];
    const dependencies: Dependency[] = [];
    const fieldReferences: FieldReference[] = [];
    const risks: Risk[] = [];

    try {
      if (language.toLowerCase() === "go") {
        const parser = new GoParser(content, filePath);

        // 解析符號
        symbols.push(...parser.parseFunctions());
        symbols.push(...parser.parseStructs());

        // 解析依賴
        dependencies.push(...parser.parseCalls());

        // 解析欄位引用
        fieldReferences.push(...parser.parseDBOperations());

        // 檢測魔法值
        const magicValues = parser.detectMagicValues();
        risks.push(...this.riskDetector.detectMagicValues(magicValues));

        // 檢測並發風險
        risks.push(...this.riskDetector.detectConcurrencyRisks(content, filePath));
      } else if (language.toLowerCase() === "sql") {
        const parser = new SQLParser(content, filePath);

        // 解析符號
        symbols.push(...parser.parseTables());
        symbols.push(...parser.parseQueries());

        // 解析欄位引用
        fieldReferences.push(...parser.parseFieldReferences());

        // 檢測危險查詢
        const dangerousQueries = parser.detectDangerousQueries();
        risks.push(
          ...this.riskDetector.detectMissingConditions(
            dangerousQueries.map((q) => ({
              ...q,
              file: filePath,
            }))
          )
        );

        // 檢測格式轉換風險
        risks.push(...this.riskDetector.detectFormatConversionRisks(content, filePath));
      }
    } catch (error) {
      console.error(`Error analyzing file ${filePath}:`, error);
    }

    return {
      symbols,
      dependencies,
      fieldReferences,
      risks,
    };
  }

  /**
   * 分析整個專案
   */
  async analyzeProject(files: Array<{ path: string; content: string; language: string }>, projectId: number): Promise<AnalysisResult> {
    const allSymbols: Symbol[] = [];
    const allDependencies: Dependency[] = [];
    const allFieldReferences: FieldReference[] = [];
    const allRisks: Risk[] = [];

    // 分析所有檔案
    for (const file of files) {
      const result = await this.analyzeFile(file.content, file.path, file.language);
      allSymbols.push(...result.symbols);
      allDependencies.push(...result.dependencies);
      allFieldReferences.push(...result.fieldReferences);
      allRisks.push(...result.risks);
    }

    // 檢測多處寫入的欄位
    const multiWriteRisks = this.riskDetector.detectMultipleWrites(allFieldReferences);
    allRisks.push(...multiWriteRisks);

    // 找出入口點（main 函數或主要查詢）
    const entryPoints = allSymbols.filter((sym) => sym.name === "main" || sym.type === "query");

    // 生成文件
    const flowDocument = this.documentGenerator.generateFlowDocument(allSymbols, allDependencies, entryPoints);
    const dataDependencyDocument = this.documentGenerator.generateDataDependencyDocument(allFieldReferences);
    const risksDocument = this.documentGenerator.generateRisksDocument(allRisks);
    const rulesYaml = this.documentGenerator.generateRulesYaml(allRisks, allFieldReferences);

    // 計算風險評分
    const riskScore = this.riskDetector.calculateRiskScore(allRisks);

    return {
      projectId,
      language: files.length > 0 ? files[0].language : "unknown",
      symbols: allSymbols,
      dependencies: allDependencies,
      fieldReferences: allFieldReferences,
      risks: allRisks,
      flowDocument,
      dataDependencyDocument,
      risksDocument,
      rulesYaml,
      riskScore,
    };
  }

  /**
   * 生成報告 ZIP
   */
  generateReportZip(result: AnalysisResult): Buffer {
    // 這是一個簡化版本，實際實現需要使用 zip 庫
    // 在真實實現中，會使用 archiver 或類似庫
    const files = {
      "FLOW.md": result.flowDocument,
      "DATA_DEPENDENCY.md": result.dataDependencyDocument,
      "RISKS.md": result.risksDocument,
      "RULES.yaml": result.rulesYaml,
    };

    // 返回 JSON 格式的檔案清單（實際應返回 ZIP Buffer）
    const content = JSON.stringify(files, null, 2);
    return Buffer.from(content);
  }
}
