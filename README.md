# Legacy Lens

**Legacy Lens** is a production-ready legacy code analysis tool that imports legacy codebases (Go, SQL, Delphi), runs structural analysis workflows, and generates comprehensive reports. It helps developers understand, document, and modernize aging software systems.

## Problem Statement

Legacy systems often suffer from:
- Missing or outdated documentation
- Undocumented business logic embedded in old code
- Risk of regression during modernization efforts
- Difficulty finding developers familiar with older languages (Delphi, PowerBuilder, etc.)

Legacy Lens addresses these pain points by providing automated structural analysis, risk detection, and exportable documentation.

## Features

### Core Capabilities
- **Multi-format Import**: Upload ZIP archives or clone Git repositories
- **Encoding Detection**: Automatic detection of UTF-8, UTF-8 BOM, and legacy encodings (Big5, CP950, Latin1, etc.) with warnings for ambiguous cases
- **Structural Analysis**: Extract symbols (functions, procedures, methods, classes, queries, tables), dependencies, and field references
- **Risk Detection**: Heuristic-based identification of magic values, multiple writes, missing conditions, format conversions, and inconsistent logic
- **Report Generation**: Markdown documentation (flow diagrams, data dependencies, risks) and YAML rule exports

### Supported Languages
| Language | Extensions | Analysis Level |
|----------|------------|----------------|
| Go | `.go` | Full symbol/dependency extraction |
| SQL | `.sql` | Query parsing, table/field extraction |
| Delphi | `.pas`, `.dpr`, `.delphi` | Full unit analysis |
| Delphi Forms | `.dfm`, `.inc`, `.dpk`, `.fmx` | Limited heuristics (imported with warnings) |

**Note**: Files in unsupported languages (TypeScript, JavaScript, Java, Python, C++, etc.) are skipped during import with explicit warnings.

## System Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Client (UI)   │────▶│  tRPC API Layer  │────▶│  Service Layer  │
│   React + Vite  │     │  Express + tRPC  │     │  Workflow Logic │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   MySQL/PlanetScale │◀───│   Drizzle ORM    │◀───│   Analyzer      │
│   Schema + Data │     │  Type-safe SQL   │     │  Parser + Risk  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Data Flow
1. **Import Phase**: User uploads ZIP or provides Git URL → Files extracted with encoding detection → Stored in `files` table
2. **Analysis Phase**: Analyzer parses each file → Extracts symbols, dependencies, field references, risks → Persisted to respective tables
3. **Report Phase**: Aggregated results written to `analysisResults` table → UI displays from DB → ZIP report generated from same persisted data

### Workflow States

**Project Lifecycle:**
- `draft` → `importing` → `ready` → `analyzing` → `completed` | `failed`

**Analysis Result Lifecycle:**
- `pending` → `processing` → `completed` | `partial` | `failed`

## Quick Start

### Prerequisites
- Node.js 20+
- pnpm 10+
- MySQL 8+ or PlanetScale account

### Environment Setup

1. Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

2. Configure required variables:
```bash
# Database
DATABASE_URL="mysql://user:password@localhost:3306/legacy_lens"

# OAuth (optional for local dev without auth)
VITE_APP_ID="your-app-id"
VITE_OAUTH_PORTAL_URL="https://oauth.example.com"
JWT_SECRET="your-jwt-secret-min-32-chars"
OAUTH_SERVER_URL="https://oauth.example.com"
OWNER_OPEN_ID="your-open-id"

# Optional: Forge integration (for advanced features)
BUILT_IN_FORGE_API_URL="https://forge.example.com"
BUILT_IN_FORGE_API_KEY="your-forge-api-key"
```

### Installation & Migration

```bash
# Install dependencies
pnpm install --frozen-lockfile

# Run database migrations
pnpm db:migrate

# (Optional) Seed sample data
# pnpm db:seed

# Start development server
pnpm dev
```

Access the application at `http://localhost:3000`.

## Available Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start development server (hot reload) |
| `pnpm build` | Build production bundles (client + server) |
| `pnpm start` | Run production server |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm lint` | ESLint validation |
| `pnpm test` | Run Vitest test suite |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm db:generate` | Generate Drizzle migrations from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:push` | Generate + apply migrations (dev only) |

## Sample Projects

The `samples/` directory contains minimal example projects for testing:

```
samples/
├── go/          # Go sample with UserService, SQL operations
├── sql/         # Standalone SQL scripts
└── delphi/      # Delphi units and forms
```

### Try It Yourself
1. Create a new project in the UI
2. Upload `samples/go.zip` (create by zipping `samples/go/` contents)
3. Wait for analysis to complete
4. Explore symbols, dependencies, and detected risks
5. Download the ZIP report

## API Reference

### Health Check
```bash
curl http://localhost:3000/api/trpc/system.health
```

Response:
```json
{
  "ok": true,
  "timestamp": "2025-01-15T10:30:00.000Z",
  "version": "1.0.0"
}
```

### Key Endpoints (tRPC)
- `project.create` - Create new analysis project
- `project.importZip` / `project.importGit` - Import source code
- `project.analyze` - Trigger analysis workflow
- `project.exportReport` - Download ZIP report
- `project.delete` - Remove project and all related data

## Testing Strategy

### Test Coverage
- **Unit Tests**: Parser logic, risk detection, encoding handling
- **Integration Tests**: Full import → analyze → export workflow
- **Edge Cases**: 
  - UTF-8 BOM files
  - Non-UTF-8 legacy encodings (Big5, Latin1)
  - Class symbol extraction
  - Large file handling (>5MB skipped with warning)
  - Empty/invalid ZIP archives

Run tests:
```bash
pnpm test
```

## Limitations & Known Issues

### Analysis Limitations
- **Heuristic Parsing**: Not compiler-grade; may miss semantic relationships across units/files
- **Dynamic SQL**: String-concatenated SQL queries may have incomplete field extraction
- **Multi-line SQL**: Embedded multi-line SQL strings may not be fully parsed
- **Delphi Cross-Unit Resolution**: Best-effort only; some inter-unit dependencies may be missed

### Encoding Support
- Fully supported: UTF-8, UTF-8 BOM
- Best-effort detection: Big5, CP950, Latin1, Windows-125x, Shift_JIS, EUC-KR, GBK
- Warning system alerts when confidence < 80% or fallback encoding used

### Scale Limits
- Max files per ZIP: 2,000
- Max single file size: 5 MB
- Max total extracted size: 500 MB

## Repository Hygiene

### Release Checklist
Before creating a release:
```bash
pnpm install --frozen-lockfile
pnpm check        # Type check
pnpm lint         # Linting
pnpm test         # All tests pass
pnpm build        # Production build succeeds
pnpm db:migrate   # Migrations apply cleanly
```

### Excluded from Releases
The following are excluded via `.gitignore` and release packaging rules:
- `.git/` - Version control metadata
- `node_modules/` - Dependencies (reinstalled via pnpm)
- `dist/` - Build artifacts
- `.manus-logs/` - Debug logs
- `coverage/` - Test coverage reports
- `*.env*` - Environment files
- OS/editor junk (`.DS_Store`, `.vscode/`, `.idea/`)

### Packaging Verification
```bash
# Verify release archive does not contain excluded files
zipinfo -1 release.zip | grep -E "^(\.git|node_modules|dist|\.manus)" && echo "FAIL: Excluded files found" || echo "PASS"
```

## CI/CD Status

[![CI](https://github.com/your-org/legacy-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/legacy-lens/actions/workflows/ci.yml)

GitHub Actions automatically runs on every push/PR:
- Dependency installation (pnpm frozen lockfile)
- TypeScript type checking
- ESLint validation
- Vitest test execution
- Production build verification

## Roadmap

### Completed ✅
- [x] ZIP/Git import with encoding detection
- [x] Go, SQL, Delphi parser support
- [x] Class symbol type support
- [x] Risk detection (5 categories)
- [x] Markdown/YAML report generation
- [x] Encoding warning system
- [x] Template module cleanup

### In Progress 🚧
- [ ] Analysis Diff / Snapshot Comparison API
- [ ] Enhanced Delphi form (`.dfm`) analysis

### Planned 📋
- [ ] Interactive dependency graph visualization
- [ ] Custom rule definition UI
- [ ] Incremental analysis (diff-based re-analysis)
- [ ] Export to Confluence / Notion
- [ ] Additional language support (PowerBuilder, COBOL)

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines
- Follow existing code style (ESLint + Prettier enforced)
- Add tests for new functionality
- Update README for user-facing changes
- Ensure migrations are backward-compatible

## License

MIT License - See LICENSE file for details.

## Acknowledgments

- Built with [tRPC](https://trpc.io/), [Drizzle ORM](https://orm.drizzle.team/), [React](https://react.dev/), [Vite](https://vitejs.dev/)
- Icons by [Lucide](https://lucide.dev/)
- UI components from [shadcn/ui](https://ui.shadcn.com/)
- Encoding detection by [jschardet](https://github.com/aadsm/jschardet) and [iconv-lite](https://github.com/ashtuchkin/iconv-lite)
