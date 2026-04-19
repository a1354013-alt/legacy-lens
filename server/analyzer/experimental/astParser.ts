/**
 * AST 解析器 - 使用 TypeScript Compiler API 和 Babel Parser
 * 進行更精確的程式碼分析
 * 
 * Note: This is experimental code not used in the production analysis pipeline.
 */

import * as ts from "typescript";
import { parse as babelParse } from "@babel/parser";
import { logger } from "../../_core/logger";

export interface ASTNode {
  type: string;
  name?: string;
  kind?: string;
  children?: ASTNode[];
  properties?: Record<string, any>;
  sourceFile?: string;
  line?: number;
  column?: number;
}

export interface FunctionInfo {
  name: string;
  type: "function" | "method" | "procedure";
  parameters: ParameterInfo[];
  returnType?: string;
  body?: string;
  isAsync?: boolean;
  isExported?: boolean;
  decorators?: string[];
  sourceFile?: string;
  line?: number;
}

export interface ParameterInfo {
  name: string;
  type?: string;
  isOptional?: boolean;
  isRest?: boolean;
  defaultValue?: string;
}

export interface VariableInfo {
  name: string;
  type?: string;
  kind: "const" | "let" | "var";
  initializer?: string;
  sourceFile?: string;
  line?: number;
}

/**
 * 使用 TypeScript Compiler API 解析 Go/TypeScript 程式碼
 */
export function parseTypeScriptAST(code: string, fileName: string = "file.ts"): ASTNode {
  try {
    const sourceFile = ts.createSourceFile(
      fileName,
      code,
      ts.ScriptTarget.Latest,
      true
    );

    return visitNode(sourceFile, code);
  } catch (error) {
    logger.warn("TypeScript AST parsing failed", { action: "experimental.ast.typescript.parse", status: "error", error: String(error) });
    return { type: "error", properties: { error: String(error) } };
  }
}

/**
 * 遞歸訪問 AST 節點
 */
function visitNode(node: ts.Node, sourceCode: string, depth: number = 0): ASTNode {
  const astNode: ASTNode = {
    type: ts.SyntaxKind[node.kind],
    properties: {},
    children: [],
  };

  // 獲取行號
  const { line, character } = ts.getLineAndCharacterOfPosition(
    node.getSourceFile(),
    node.getStart()
  );
  astNode.line = line + 1;
  astNode.column = character + 1;

  // 處理特定類型的節點
  if (ts.isFunctionDeclaration(node)) {
    astNode.name = node.name?.getText();
    astNode.properties = {
      isAsync: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || false,
      isExported: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) || false,
      parameters: node.parameters.map((p) => ({
        name: p.name?.getText(),
        type: p.type?.getText(),
        isOptional: p.questionToken !== undefined,
        isRest: p.dotDotDotToken !== undefined,
      })),
      returnType: node.type?.getText(),
    };
  } else if (ts.isVariableDeclaration(node)) {
    astNode.name = node.name?.getText();
    astNode.properties = {
      type: node.type?.getText(),
      initializer: node.initializer?.getText(),
    };
  } else if (ts.isClassDeclaration(node)) {
    astNode.name = node.name?.getText();
    astNode.properties = {
      isExported: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) || false,
      baseClass: node.heritageClauses
        ?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
        ?.types[0]?.expression?.getText(),
    };
  } else if (ts.isMethodDeclaration(node)) {
    astNode.name = node.name?.getText();
    astNode.properties = {
      isAsync: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || false,
      isStatic: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) || false,
      parameters: node.parameters.map((p) => ({
        name: p.name?.getText(),
        type: p.type?.getText(),
      })),
      returnType: node.type?.getText(),
    };
  } else if (ts.isCallExpression(node)) {
    astNode.properties = {
      expression: node.expression.getText(),
      arguments: node.arguments.map((a) => a.getText()),
    };
  }

  // 遞歸處理子節點（限制深度以避免過度遞歸）
  if (depth < 10) {
    ts.forEachChild(node, (child) => {
      astNode.children?.push(visitNode(child, sourceCode, depth + 1));
    });
  }

  return astNode;
}

/**
 * 使用 Babel Parser 解析 JavaScript/TypeScript 程式碼
 */
export function parseBabelAST(code: string, language: "javascript" | "typescript" = "javascript"): ASTNode {
  try {
    const ast = babelParse(code, {
      sourceType: "module",
      plugins: [
        "jsx",
        language === "typescript" ? "typescript" : null,
        "decorators",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "logicalAssignment",
        "pipelineOperator",
        "partialApplication",
        "optionalChaining",
        "nullishCoalescingOperator",
      ].filter(Boolean) as any,
    });

    return visitBabelNode(ast);
  } catch (error) {
    logger.warn("Babel AST parsing failed", { action: "experimental.ast.babel.parse", status: "error", error: String(error) });
    return { type: "error", properties: { error: String(error) } };
  }
}

/**
 * 遞歸訪問 Babel AST 節點
 */
function visitBabelNode(node: any, depth: number = 0): ASTNode {
  const astNode: ASTNode = {
    type: node.type,
    properties: {},
    children: [],
  };

  if (node.loc) {
    astNode.line = node.loc.start.line;
    astNode.column = node.loc.start.column;
  }

  // 處理特定類型的節點
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
    astNode.name = node.id?.name;
    astNode.properties = {
      isAsync: node.async || false,
      parameters: node.params.map((p: any) => ({
        name: p.name,
        type: p.typeAnnotation?.typeAnnotation?.name,
      })),
      returnType: node.returnType?.typeAnnotation?.name,
    };
  } else if (node.type === "VariableDeclarator") {
    astNode.name = node.id?.name;
    astNode.properties = {
      kind: node.kind,
      initializer: node.init?.type,
    };
  } else if (node.type === "ClassDeclaration") {
    astNode.name = node.id?.name;
    astNode.properties = {
      superClass: node.superClass?.name,
    };
  } else if (node.type === "CallExpression") {
    astNode.properties = {
      callee: node.callee?.name || node.callee?.property?.name,
      arguments: node.arguments.length,
    };
  }

  // 遞歸處理子節點
  if (depth < 10) {
    for (const key in node) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;

      const child = node[key];
      if (child && typeof child === "object") {
        if (Array.isArray(child)) {
          child.forEach((item: any) => {
            if (item && typeof item === "object" && item.type) {
              astNode.children?.push(visitBabelNode(item, depth + 1));
            }
          });
        } else if (child.type) {
          astNode.children?.push(visitBabelNode(child, depth + 1));
        }
      }
    }
  }

  return astNode;
}

/**
 * 從 AST 提取所有函數定義
 */
export function extractFunctionsFromAST(ast: ASTNode): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  function traverse(node: ASTNode) {
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
      functions.push({
        name: node.name || "anonymous",
        type: "function",
        parameters: (node.properties?.parameters || []) as ParameterInfo[],
        returnType: node.properties?.returnType,
        isAsync: node.properties?.isAsync,
        isExported: node.properties?.isExported,
        line: node.line,
      });
    } else if (node.type === "MethodDeclaration") {
      functions.push({
        name: node.name || "anonymous",
        type: "method",
        parameters: (node.properties?.parameters || []) as ParameterInfo[],
        returnType: node.properties?.returnType,
        isAsync: node.properties?.isAsync,
        line: node.line,
      });
    }

    node.children?.forEach(traverse);
  }

  traverse(ast);
  return functions;
}

/**
 * 從 AST 提取所有變數定義
 */
export function extractVariablesFromAST(ast: ASTNode): VariableInfo[] {
  const variables: VariableInfo[] = [];

  function traverse(node: ASTNode) {
    if (node.type === "VariableDeclarator" || node.type === "VariableDeclaration") {
      variables.push({
        name: node.name || "unknown",
        type: node.properties?.type,
        kind: node.properties?.kind || "var",
        initializer: node.properties?.initializer,
        line: node.line,
      });
    }

    node.children?.forEach(traverse);
  }

  traverse(ast);
  return variables;
}

/**
 * 從 AST 提取所有函數呼叫
 */
export function extractCallsFromAST(ast: ASTNode): Array<{ name: string; line?: number }> {
  const calls: Array<{ name: string; line?: number }> = [];

  function traverse(node: ASTNode) {
    if (node.type === "CallExpression") {
      const callee = node.properties?.callee || node.properties?.expression;
      if (callee) {
        calls.push({
          name: callee,
          line: node.line,
        });
      }
    }

    node.children?.forEach(traverse);
  }

  traverse(ast);
  return calls;
}

/**
 * 計算 AST 的複雜度指標
 */
export function calculateComplexity(ast: ASTNode): {
  cyclomaticComplexity: number;
  nesting: number;
  size: number;
} {
  let cyclomaticComplexity = 1;
  let maxNesting = 0;
  let currentNesting = 0;
  let size = 0;

  function traverse(node: ASTNode, depth: number = 0) {
    size++;
    currentNesting = Math.max(currentNesting, depth);
    maxNesting = Math.max(maxNesting, currentNesting);

    // 增加複雜度的節點
    if (
      ["IfStatement", "ForStatement", "WhileStatement", "CaseClause", "CatchClause"].includes(
        node.type
      )
    ) {
      cyclomaticComplexity++;
    }

    node.children?.forEach((child) => traverse(child, depth + 1));
  }

  traverse(ast);

  return {
    cyclomaticComplexity,
    nesting: maxNesting,
    size,
  };
}
