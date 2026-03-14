/**
 * Legacy Lens - 程式碼解析引擎
 * 支援 Go 和 SQL 程式碼的静态分析
 */

import { parseTypeScriptAST, parseBabelAST, extractFunctionsFromAST, extractCallsFromAST, calculateComplexity } from "./astParser";

export interface Symbol {
  id?: number;
  name: string;
  type: "function" | "method" | "query" | "procedure" | "table";
  file: string;
  startLine: number;
  endLine: number;
  signature?: string;
  description?: string;
}

export interface Dependency {
  from: string; // 呼叫者
  to: string; // 被呼叫者
  type: "calls" | "reads" | "writes"; // 呼叫、讀取、寫入
  line: number;
}

export interface FieldReference {
  field: string;
  table: string;
  type: "read" | "write" | "calculate";
  file: string;
  line: number;
}

export interface MagicValue {
  value: string;
  type: string; // "string" | "number" | "date"
  file: string;
  line: number;
  context: string; // 上下文片段
}

/**
 * Go 程式碼解析器
 */
export class GoParser {
  private content: string;
  private file: string;

  constructor(content: string, file: string) {
    this.content = content;
    this.file = file;
  }

  /**
   * 解析 Go 函數定義
   * 匹配模式：func (receiver) FunctionName(params) returnType { ... }
   */
  parseFunctions(): Symbol[] {
    const symbols: Symbol[] = [];
    const lines = this.content.split("\n");

    // 匹配函數定義
    const funcRegex = /^\s*func\s+(?:\([^)]*\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;

    lines.forEach((line, index) => {
      const match = line.match(funcRegex);
      if (match) {
        const name = match[1];
        symbols.push({
          name,
          type: "function",
          file: this.file,
          startLine: index + 1,
          endLine: index + 1,
          signature: line.trim(),
        });
      }
    });

    return symbols;
  }

  /**
   * 解析 Go 結構體和方法
   */
  parseStructs(): Symbol[] {
    const symbols: Symbol[] = [];
    const lines = this.content.split("\n");

    // 匹配結構體定義
    const structRegex = /^\s*type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+struct/;

    lines.forEach((line, index) => {
      const match = line.match(structRegex);
      if (match) {
        const name = match[1];
        symbols.push({
          name,
          type: "table", // 在 Go 中，struct 類似於表
          file: this.file,
          startLine: index + 1,
          endLine: index + 1,
          signature: line.trim(),
        });
      }
    });

    return symbols;
  }

  /**
   * 解析函數呼叫關係
   */
  parseCalls(): Dependency[] {
    const dependencies: Dependency[] = [];
    const lines = this.content.split("\n");

    // 匹配函數呼叫：functionName(...) 或 receiver.Method(...)
    const callRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

    lines.forEach((line, index) => {
      let match;
      while ((match = callRegex.exec(line)) !== null) {
        const calledFunc = match[1];
        // 排除關鍵字
        if (!["if", "for", "switch", "return", "func", "type"].includes(calledFunc)) {
          dependencies.push({
            from: "unknown", // 在完整分析中會被填充
            to: calledFunc,
            type: "calls",
            line: index + 1,
          });
        }
      }
    });

    return dependencies;
  }

  /**
   * 解析資料庫操作（db.Query, db.Exec 等）
   */
  parseDBOperations(): FieldReference[] {
    const references: FieldReference[] = [];
    const lines = this.content.split("\n");

    // 匹配 db.Query、db.Exec、db.Insert 等
    const dbRegex = /db\.(Query|Exec|Insert|Update|Delete)\s*\(\s*["']([^"']+)["']/g;

    lines.forEach((line, index) => {
      let match;
      while ((match = dbRegex.exec(line)) !== null) {
        const operation = match[1].toLowerCase();
        const sql = match[2];

        // 簡單的 SQL 分析
        const type = operation === "query" ? "read" : "write";
        references.push({
          field: "sql_statement",
          table: "unknown",
          type,
          file: this.file,
          line: index + 1,
        });
      }
    });

    return references;
  }

  /**
   * 檢測魔法值（硬編碼的常數）
   */
  detectMagicValues(): MagicValue[] {
    const magicValues: MagicValue[] = [];
    const lines = this.content.split("\n");

    // 匹配字串字面值（長度 > 3）
    const stringRegex = /["']([^"']{4,})["']/g;
    // 匹配數字（不是在註解中）
    const numberRegex = /\b(\d{4,})\b/g;

    lines.forEach((line, index) => {
      // 跳過註解
      if (line.trim().startsWith("//")) return;

      let match;

      // 檢查字串
      while ((match = stringRegex.exec(line)) !== null) {
        magicValues.push({
          value: match[1],
          type: "string",
          file: this.file,
          line: index + 1,
          context: line.trim(),
        });
      }

      // 檢查數字
      while ((match = numberRegex.exec(line)) !== null) {
        magicValues.push({
          value: match[1],
          type: "number",
          file: this.file,
          line: index + 1,
          context: line.trim(),
        });
      }
    });

    return magicValues;
  }
}

/**
 * SQL 程式碼解析器
 */
export class SQLParser {
  private content: string;
  private file: string;

  constructor(content: string, file: string) {
    this.content = content;
    this.file = file;
  }

  /**
   * 解析 SQL 表定義
   */
  parseTables(): Symbol[] {
    const symbols: Symbol[] = [];
    const lines = this.content.split("\n");

    // 匹配 CREATE TABLE
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/i;

    lines.forEach((line, index) => {
      const match = line.match(tableRegex);
      if (match) {
        const name = match[1];
        symbols.push({
          name,
          type: "table",
          file: this.file,
          startLine: index + 1,
          endLine: index + 1,
          signature: line.trim(),
        });
      }
    });

    return symbols;
  }

  /**
   * 解析 SQL 查詢和存儲過程
   */
  parseQueries(): Symbol[] {
    const symbols: Symbol[] = [];
    const lines = this.content.split("\n");

    // 匹配 SELECT、INSERT、UPDATE、DELETE
    const queryRegex = /^(SELECT|INSERT|UPDATE|DELETE|CREATE\s+PROCEDURE|CREATE\s+FUNCTION)\s+/i;

    lines.forEach((line, index) => {
      const match = line.match(queryRegex);
      if (match) {
        const type = match[1].toUpperCase();
        let symbolType: "query" | "procedure" | "function" = "query";
        if (type.includes("PROCEDURE")) symbolType = "procedure";
        if (type.includes("FUNCTION")) symbolType = "function";

        symbols.push({
          name: `${type}_${index}`,
          type: symbolType,
          file: this.file,
          startLine: index + 1,
          endLine: index + 1,
          signature: line.trim(),
        });
      }
    });

    return symbols;
  }

  /**
   * 解析欄位引用（SELECT、WHERE、INSERT、UPDATE）
   */
  parseFieldReferences(): FieldReference[] {
    const references: FieldReference[] = [];
    const lines = this.content.split("\n");

    lines.forEach((line, index) => {
      // 匹配 SELECT 子句中的欄位
      const selectMatch = line.match(/SELECT\s+([^FROM]+)/i);
      if (selectMatch) {
        const fields = selectMatch[1].split(",");
        fields.forEach((field) => {
          const fieldName = field.trim().split(/\s+/).pop() || "";
          if (fieldName && fieldName !== "*") {
            references.push({
              field: fieldName,
              table: "unknown",
              type: "read",
              file: this.file,
              line: index + 1,
            });
          }
        });
      }

      // 匹配 INSERT 子句中的欄位
      const insertMatch = line.match(/INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]+)\)/i);
      if (insertMatch) {
        const table = insertMatch[1];
        const fields = insertMatch[2].split(",");
        fields.forEach((field) => {
          const fieldName = field.trim();
          references.push({
            field: fieldName,
            table,
            type: "write",
            file: this.file,
            line: index + 1,
          });
        });
      }

      // 匹配 UPDATE 子句中的欄位
      const updateMatch = line.match(/UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+SET\s+([^WHERE]+)/i);
      if (updateMatch) {
        const table = updateMatch[1];
        const setClause = updateMatch[2];
        const fields = setClause.split(",");
        fields.forEach((field) => {
          const fieldName = field.split("=")[0].trim();
          references.push({
            field: fieldName,
            table,
            type: "write",
            file: this.file,
            line: index + 1,
          });
        });
      }
    });

    return references;
  }

  /**
   * 檢測 SQL 缺少 WHERE 條件的危險查詢
   */
  detectDangerousQueries(): Array<{ type: string; line: number; query: string }> {
    const dangerous: Array<{ type: string; line: number; query: string }> = [];
    const lines = this.content.split("\n");

    lines.forEach((line, index) => {
      // 檢測 DELETE 或 UPDATE 沒有 WHERE
      if (/^(DELETE|UPDATE)\s+/i.test(line) && !/WHERE\s+/i.test(line)) {
        dangerous.push({
          type: "missing_where",
          line: index + 1,
          query: line.trim(),
        });
      }
    });

    return dangerous;
  }
}

/**
 * 統一的解析器工廠
 */
export class ParserFactory {
  static createParser(language: string, content: string, file: string) {
    if (language.toLowerCase() === "go") {
      return new GoParser(content, file);
    } else if (language.toLowerCase() === "sql") {
      return new SQLParser(content, file);
    }
    throw new Error(`Unsupported language: ${language}`);
  }
}
