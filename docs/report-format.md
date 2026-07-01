# Legacy Lens Report ZIP Format

Legacy Lens report ZIP files are outputs from heuristic static analysis. They are useful for legacy impact analysis, Delphi project audit, code review support, and migration planning.

Legacy Lens is not a compiler-grade parser and does not replace human code review. Treat the report as a structured review aid: it can highlight relationships, risks, limitations, and follow-up questions, but it cannot prove complete runtime behavior.

## Report Files

### EXECUTIVE_SUMMARY.md

Purpose: Gives managers, PMs, interviewers, and senior stakeholders a quick high-level summary.

Audience: Non-engineering stakeholders, engineering leads, PMs, hiring reviewers, and managers.

Data sources: Persisted project metadata, analysis metrics, final confidence score, warnings, risks, Delphi audit artifacts, field access findings, and report limitations.

Contents:
- Project size and scan scope
- Analysis confidence score and level
- Top findings and risks
- Recommended handling order
- Manual review notice

### PROJECT_OVERVIEW.md

Purpose: Helps engineers review the project scan at a glance.

Audience: Engineers, tech leads, migration planners, and reviewers.

Data sources: Persisted project metadata, file inventory, language classification, warnings, risks, field access findings, and final analysis confidence.

Contents:
- File counts
- Language distribution
- Warning counts
- Main findings statistics
- Analysis confidence

### FILE_INVENTORY.md

Purpose: Shows which files were scanned, which files had limited analysis, and which files were skipped or degraded.

Audience: Engineers validating scan coverage and import quality.

Data sources: Persisted project files, symbols, dependencies, risks, import warnings, and analyzer warnings.

Contents:
- File path
- File type and language
- Analysis status
- Symbol count
- Dependency count
- Risk count
- Warning count

### FLOW.md

Purpose: Shows primary symbols and flow dependencies discovered during analysis.

Audience: Engineers reviewing control flow, symbol relationships, or migration impact.

Data sources: Analyzer output persisted in the analysis result.

Contents:
- Symbols
- Dependencies
- Flow relationships

### DATA_DEPENDENCY.md

Purpose: Shows data-related dependencies such as tables, fields, SQL references, and Delphi field or parameter access.

Audience: Engineers auditing data flow, database coupling, and migration risk.

Data sources: Persisted fields, field dependencies, SQL findings, and analyzer context.

Contents:
- Table and field names
- Read/write access
- SQL, FieldByName, and ParamByName references
- Source context where available

### RISKS.md

Purpose: Lists risk findings and supports prioritization.

Audience: Engineers, tech leads, reviewers, and migration planners.

Data sources: Persisted analyzer risk findings.

Contents:
- Risk type
- Severity
- Location
- Description
- Recommendation where available

### RULES.yaml

Purpose: Provides a machine-readable rule summary for later automation or review workflows.

Audience: Tooling, CI integrations, reviewers, and engineers building follow-up checks.

Data sources: Persisted analyzer rule output.

Contents:
- Rule identifiers and types
- Rule names and descriptions
- Conditions and source locations where available

### IMPACT_ANALYSIS.md

Purpose: Provides a high-level impact analysis summary.

Audience: Engineers, tech leads, PMs, and migration planners.

Data sources: Persisted files, symbols, dependencies, risks, and rules.

Contents:
- Top impacted files
- Dependency impact signals
- Risk and rule summaries
- High-level review priorities

### DELPHI_FIELD_ACCESS.md

Purpose: Shows Delphi FieldByName and ParamByName access detected in persisted analysis artifacts.

Audience: Delphi engineers, database migration reviewers, and code reviewers.

Data sources: Persisted field dependencies and source context.

Contents:
- File
- Line
- Field or parameter name
- Read/write access
- Context

### DELPHI_EVENT_MAP.md

Purpose: Shows whether DFM/FMX event handlers were matched to Pascal methods.

Audience: Delphi engineers and reviewers auditing form behavior.

Data sources: Persisted Delphi event map metadata from DFM/FMX and Pascal analysis.

Contents:
- Form
- Component
- Event
- Handler
- Resolved or unresolved status
- Warnings where available

### DELPHI_DATA_BINDINGS.md

Purpose: Shows DB-aware component bindings to DataSource, DataSet, and DataField metadata.

Audience: Delphi engineers, database migration reviewers, and QA leads.

Data sources: Persisted Delphi data binding metadata from DFM/FMX analysis.

Contents:
- Component
- DataSource
- DataSet
- DataField
- Confidence
- Warnings

### LIMITATIONS.md

Purpose: Explains analysis limits and manual review requirements.

Audience: All report readers.

Data sources: Static report limitation text generated with the export.

Contents:
- Static-analysis limitations
- Delphi-specific limitations
- Manual verification guidance

### FULL_FINDINGS.json

Purpose: Provides machine-readable complete findings for dashboards, CI, APIs, or follow-up tooling.

Audience: Integrations, automation, engineers, and analysts.

Data sources: Persisted project metadata, files, symbols, dependencies, risks, rules, field accesses, Delphi findings, warnings, and confidence.

Contents:
- Metadata and confidence
- File inventory
- Symbols and dependencies
- Risks and rules
- Field accesses
- Delphi event and data binding findings
- Import and analyzer warnings

### impact-analysis.json

Purpose: Provides machine-readable impact analysis output.

Audience: Integrations, dashboards, CI, and automation.

Data sources: Persisted files, symbols, dependencies, risks, and rules.

Contents:
- Impact summary
- Top impacted files
- Dependency summaries
- High-risk items
- Rule summaries

### import-warnings.json

Purpose: Records import-stage warnings.

Audience: Engineers validating import quality and scan coverage.

Data sources: Persisted project import warnings.

Contents:
- Skipped files
- Limited analysis warnings
- Oversized file warnings
- Encoding or extraction warnings

### metadata.json

Purpose: Provides report metadata for audit, replay, and indexing.

Audience: Integrations, auditors, engineers, and report consumers.

Data sources: Persisted project metadata, report metadata, metrics, import warning count, and final confidence.

Contents:
- Project name
- Analysis version
- Analyzed at timestamp
- Focus language
- File, symbol, dependency, and warning counts
- Confidence

### analysis-summary.json

Purpose: Provides a compact analysis summary for the frontend and external systems.

Audience: Frontend clients, dashboards, API consumers, and automation.

Data sources: Persisted analysis result, metrics, final confidence, analyzer warnings, import warnings, and limitation summary.

Contents:
- Analysis result id
- Status
- Metrics
- Confidence
- Warnings
- Import warnings
- Limitation summary

## Analysis Confidence Score

The analysis confidence score ranges from 0 to 100 and is grouped into high, medium, and low levels.

This score represents confidence in the static analysis result. It is not a code quality score and should not be treated as a business risk score by itself.

Confidence can decrease when the analysis detects uncertainty signals such as:
- Unresolved DFM/FMX event handlers
- Dynamic SQL
- Limited analysis files
- Unknown language or extension
- Import warnings
- Skipped or degraded files
- Unresolved DataSource, DataSet, or DataField bindings

Use low or medium confidence as a prompt for manual review before relying on the report for planning or remediation decisions.

## Delphi-Specific Limitations

Delphi and C++Builder projects often rely on runtime behavior that static analysis cannot fully recover. Review the following cases manually:

- `with` block ownership may not be fully inferred.
- Runtime event binding may not be resolvable from DFM/FMX and Pascal source alone.
- Inherited forms may require manual confirmation.
- Dynamic SQL can only be partially reconstructed.
- DFM, FMX, PAS, DPR, and INC encoding issues may affect parsed results.
- DataSource and DataSet runtime assignment may not be resolved.
- Runtime-created components may not appear in DFM/FMX analysis.

These limitations do not make the report unusable; they define where human review is still required.
