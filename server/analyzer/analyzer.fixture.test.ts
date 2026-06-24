import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Analyzer } from "./analyzer";
import type { AnalyzableFile, ProjectAnalysisResult } from "./types";

const fixtureCases = [
  { name: "go-cross-file", files: ["main.go", "helpers.go"] },
  { name: "sql-dynamic", files: ["repo.sql"] },
  { name: "delphi-dfm-event", files: ["Form1.pas", "Form1.dfm"] },
  { name: "delphi-fieldbyname", files: ["Repo.pas"] },
  { name: "delphi-parambyname", files: ["Repo.pas"] },
] as const;

function fixtureDir(name: string) {
  return path.join(process.cwd(), "samples", "fixtures", name);
}

function languageFor(fileName: string): AnalyzableFile["language"] {
  if (fileName.endsWith(".go")) return "go";
  if (fileName.endsWith(".sql")) return "sql";
  return "delphi";
}

function sortByJson<T>(items: T[]) {
  return [...items].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizeAnalysis(result: ProjectAnalysisResult) {
  return {
    symbols: sortByJson(
      result.symbols.map((symbol) => ({
        name: symbol.name,
        qualifiedName: symbol.qualifiedName ?? null,
        type: symbol.type,
        file: symbol.file,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
      }))
    ),
    fields: sortByJson(
      result.fieldReferences.map((field) => ({
        table: field.table,
        field: field.field,
        type: field.type,
        file: field.file,
        line: field.line,
        symbolName: field.symbolName ?? null,
      }))
    ),
    dependencies: sortByJson(
      result.dependencies.map((dependency) => ({
        fromName: dependency.fromName,
        toName: dependency.toName,
        type: dependency.type,
        line: dependency.line,
      }))
    ),
    risks: sortByJson(
      result.risks.map((risk) => ({
        title: risk.title,
        category: risk.category,
        severity: risk.severity,
        sourceFile: risk.sourceFile,
        lineNumber: risk.lineNumber,
      }))
    ),
    rules: sortByJson(
      result.rules.map((rule) => ({
        name: rule.name,
        ruleType: rule.ruleType,
        sourceFile: rule.sourceFile ?? null,
        lineNumber: rule.lineNumber ?? null,
      }))
    ),
  };
}

async function readFixtureFiles(name: string, files: readonly string[]): Promise<AnalyzableFile[]> {
  return Promise.all(
    files.map(async (fileName) => ({
      path: fileName,
      language: languageFor(fileName),
      content: await readFile(path.join(fixtureDir(name), fileName), "utf8"),
    }))
  );
}

async function readExpectedAnalysis(name: string) {
  const raw = await readFile(path.join(fixtureDir(name), "expected-analysis.json"), "utf8");
  return JSON.parse(raw);
}

describe("Analyzer fixture snapshots", () => {
  it.each(fixtureCases)("matches expected analysis for $name", async ({ name, files }) => {
    const analyzer = new Analyzer();
    const actual = await analyzer.analyzeProject(await readFixtureFiles(name, files), 1);
    const expected = await readExpectedAnalysis(name);

    expect(normalizeAnalysis(actual)).toEqual(expected);
  });
});
