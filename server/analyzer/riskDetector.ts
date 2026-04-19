import type { DetectedRisk, FieldReference } from "./types";

export interface MagicValueCandidate {
  value: string;
  file: string;
  line: number;
  context: string;
  kind: "string" | "number";
}

export class RiskDetector {
  detectMagicValues(candidates: MagicValueCandidate[]): DetectedRisk[] {
    return candidates.flatMap((candidate) => {
      if (["0", "1", "-1", "100"].includes(candidate.value)) {
        return [];
      }

      const risks: DetectedRisk[] = [];
      const isDateLike = /^\d{8}$/.test(candidate.value) || /^\d{4}-\d{2}-\d{2}$/.test(candidate.value);

      if (isDateLike) {
        risks.push({
          title: "Date literal embedded in code",
          description: `Found hard-coded date value "${candidate.value}" in executable code.`,
          severity: "medium",
          category: "magic_value",
          sourceFile: candidate.file,
          lineNumber: candidate.line,
          suggestion: "Promote the value to a named constant or configuration entry.",
          codeSnippet: candidate.context,
        });
      } else if (candidate.kind === "number" && candidate.value.length >= 4) {
        risks.push({
          title: "Large numeric literal embedded in code",
          description: `Found numeric literal "${candidate.value}" that should be documented or externalized.`,
          severity: "medium",
          category: "magic_value",
          sourceFile: candidate.file,
          lineNumber: candidate.line,
          suggestion: "Replace the literal with a named constant and document the business meaning.",
          codeSnippet: candidate.context,
        });
      } else if (candidate.kind === "string" && candidate.value.length >= 10) {
        risks.push({
          title: "String literal with business meaning",
          description: `Found long string literal "${candidate.value.slice(0, 40)}" embedded in code.`,
          severity: "low",
          category: "magic_value",
          sourceFile: candidate.file,
          lineNumber: candidate.line,
          suggestion: "Consider centralizing repeated business literals.",
          codeSnippet: candidate.context,
        });
      }

      return risks;
    });
  }

  detectMultipleWrites(fieldReferences: FieldReference[]): DetectedRisk[] {
    const writeMap = new Map<string, FieldReference[]>();

    for (const reference of fieldReferences) {
      if (reference.type !== "write") continue;
      const key = `${reference.table}.${reference.field}`;
      const bucket = writeMap.get(key) ?? [];
      bucket.push(reference);
      writeMap.set(key, bucket);
    }

    const risks: DetectedRisk[] = [];
    for (const [fieldKey, references] of Array.from(writeMap.entries())) {
      if (references.length < 2) continue;
      const first = references[0];
      risks.push({
        title: `Field ${fieldKey} is written from multiple locations`,
        description: `${fieldKey} has ${references.length} write operations across the codebase, which raises drift risk.`,
        severity: references.length >= 3 ? "high" : "medium",
        category: "multiple_writes",
        sourceFile: first.file,
        lineNumber: first.line,
        suggestion: "Review whether the field should have a single write owner or stronger validation.",
        codeSnippet: references.map((reference: FieldReference) => `${reference.file}:${reference.line}`).join(", "),
      });
    }

    return risks;
  }

  detectMissingConditions(sqlSnippets: Array<{ file: string; line: number; sql: string }>): DetectedRisk[] {
    return sqlSnippets.flatMap((snippet) => {
      if (!/^(UPDATE|DELETE)\b/i.test(snippet.sql)) {
        return [];
      }

      if (/\bWHERE\b/i.test(snippet.sql)) {
        return [];
      }

      return [
        {
          title: "Write statement without WHERE clause",
          description: "Detected UPDATE/DELETE statement without a WHERE clause.",
          severity: "critical",
          category: "missing_condition",
          sourceFile: snippet.file,
          lineNumber: snippet.line,
          suggestion: "Add an explicit predicate or document why full-table mutation is safe.",
          codeSnippet: snippet.sql,
        },
      ];
    });
  }

  detectDelphiPatterns(content: string, file: string): DetectedRisk[] {
    const risks: DetectedRisk[] = [];
    const lines = content.split(/\r?\n/);
    const seen = new Set<string>();
    let i = 0;

    while (i < lines.length) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("{") || trimmed.startsWith("(*")) {
        i++;
        continue;
      }

      const fieldByNameMatch = trimmed.match(/FieldByName\(\s*['"]([^'"]+)['"]\s*\)/i);
      if (fieldByNameMatch) {
        const key = `FieldByName:${fieldByNameMatch[1]}:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          risks.push({
            title: "Delphi field access detected",
            description: `Found FieldByName("${fieldByNameMatch[1]}") usage. Review data access patterns and result validation.`,
            severity: "low",
            category: "other",
            sourceFile: file,
            lineNumber: i + 1,
            suggestion: "Confirm that field names are valid and that the data access is protected against missing fields.",
            codeSnippet: trimmed,
          });
        }
      }

      const paramByNameMatch = trimmed.match(/ParamByName\(\s*['"]([^'"]+)['"]\s*\)/i);
      if (paramByNameMatch) {
        const key = `ParamByName:${paramByNameMatch[1]}:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          risks.push({
            title: "Delphi query parameter usage detected",
            description: `Found ParamByName("${paramByNameMatch[1]}"); verify parameters are used consistently with the SQL statement.`,
            severity: "low",
            category: "other",
            sourceFile: file,
            lineNumber: i + 1,
            suggestion: "Verify that parameters are applied to parameterized SQL statements rather than string-concatenated queries.",
            codeSnippet: trimmed,
          });
        }
      }

      if (/\bSQL\.Add\s*\(/i.test(trimmed) && /\+/.test(trimmed)) {
        const key = `SQL.Add.dynamic:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          risks.push({
            title: "Dynamic Delphi SQL construction",
            description: "Detected SQL.Add with string concatenation; this can expose the application to SQL injection or broken queries.",
            severity: "high",
            category: "other",
            sourceFile: file,
            lineNumber: i + 1,
            suggestion: "Use parameterized query building and avoid concatenating user input into SQL strings.",
            codeSnippet: trimmed,
          });
        }
      }

      if (/\bSQL\.Text\b.*:=.*\+/.test(trimmed)) {
        const key = `SQL.Text.dynamic:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          risks.push({
            title: "Dynamic SQL text assignment",
            description: "Detected SQL.Text assignment using string concatenation; this is a common source of query risk.",
            severity: "high",
            category: "other",
            sourceFile: file,
            lineNumber: i + 1,
            suggestion: "Review the SQL text and convert it to parameterized queries where possible.",
            codeSnippet: trimmed,
          });
        }
      }

      if (/\bexcept\b/i.test(trimmed) && !/raise\b/i.test(trimmed)) {
        let j = i + 1;
        let foundEmptyHandler = false;
        while (j < Math.min(i + 10, lines.length)) {
          const nextTrimmed = (lines[j] ?? "").trim();
          if (!nextTrimmed) {
            j++;
            continue;
          }
          if (nextTrimmed === ";") {
            foundEmptyHandler = true;
            break;
          }
          if (/^end;?$/i.test(nextTrimmed) && !foundEmptyHandler) {
            foundEmptyHandler = true;
            break;
          }
          if (/\b(on|raise|begin|try)\b/i.test(nextTrimmed) || /^[^;]*:=/.test(nextTrimmed)) {
            break;
          }
          j++;
        }
        if (foundEmptyHandler) {
          const key = `empty.except:${i}`;
          if (!seen.has(key)) {
            seen.add(key);
            risks.push({
              title: "Broad or empty Delphi exception handling",
              description: "Found an except block without a concrete handling action; this can suppress runtime failures.",
              severity: "high",
              category: "other",
              sourceFile: file,
              lineNumber: i + 1,
              suggestion: "Avoid empty exception handlers and handle or log exceptions explicitly.",
              codeSnippet: trimmed,
            });
          }
        }
      }

      const dbComponentMatch = trimmed.match(/\b(TQuery|TADOQuery|TClientDataSet|TFDQuery|DataSource)\b/i);
      if (dbComponentMatch) {
        const key = `query.type:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          risks.push({
            title: "Delphi database component detected",
            description: `Found Delphi database component usage (${dbComponentMatch[1]}). Review connection and query handling patterns.`,
            severity: "low",
            category: "other",
            sourceFile: file,
            lineNumber: i + 1,
            suggestion: "Check whether the component uses parameterized queries and proper transaction boundaries.",
            codeSnippet: trimmed,
          });
        }
      }

      if (/([A-Za-z]:\\|\\\\)[^"'\s]+/.test(trimmed) || /\b(Database|Data Source|User ID|Password|Pwd|Server|Provider)\b/i.test(trimmed)) {
        const key = `hardcoded.path:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          risks.push({
            title: "Hardcoded Delphi path or connection string",
            description: "Detected a hardcoded filesystem path or connection string pattern in Delphi code.",
            severity: "medium",
            category: "other",
            sourceFile: file,
            lineNumber: i + 1,
            suggestion: "Move environment-specific values to configuration and avoid literal paths in code.",
            codeSnippet: trimmed,
          });
        }
      }

      i++;
    }

    return risks;
  }

  detectFormatConversionRisks(content: string, file: string): DetectedRisk[] {
    const lines = content.split(/\r?\n/);
    const patterns: Array<{ regex: RegExp; severity: DetectedRisk["severity"]; label: string }> = [
      { regex: /Parse(Time|Date)|Format(Date|Time)|strftime/i, severity: "medium", label: "date/time conversion" },
      { regex: /ParseFloat|Round\(|Truncate\(|Decimal/i, severity: "high", label: "amount conversion" },
    ];

    const risks: DetectedRisk[] = [];
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        if (!pattern.regex.test(line)) {
          continue;
        }

        risks.push({
          title: `Potential ${pattern.label} inconsistency`,
          description: `Found ${pattern.label} logic that should be aligned with documented business rules.`,
          severity: pattern.severity,
          category: "format_conversion",
          sourceFile: file,
          lineNumber: index + 1,
          suggestion: "Verify precision, timezone, and canonical format rules against the target system.",
          codeSnippet: line.trim(),
        });
      }
    });

    return risks;
  }

  calculateRiskScore(risks: DetectedRisk[]): number {
    const weights: Record<DetectedRisk["severity"], number> = {
      critical: 40,
      high: 20,
      medium: 8,
      low: 3,
    };

    return risks.reduce((total, risk) => total + weights[risk.severity], 0);
  }
}