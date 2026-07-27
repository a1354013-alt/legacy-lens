import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FileTable, PaginationControls, ProjectSummaryCard, ReportActions, RiskPanel, WarningSummaryCard } from "./components";

describe("analysis result extracted components", () => {
  it("renders report actions with disabled download state when the report is unavailable", () => {
    const html = renderToStaticMarkup(
      <ReportActions
        isRefreshing={false}
        isDownloading={false}
        canDownload={false}
        isRunning={false}
        onRefresh={vi.fn()}
        onDownload={vi.fn()}
      />
    );

    expect(html).toContain("Download report ZIP");
    expect(html).toContain("disabled");
  });

  it("renders project summary rows and file table rows", () => {
    const summaryHtml = renderToStaticMarkup(<ProjectSummaryCard rows={[{ label: "Status", value: "completed" }]} />);
    const tableHtml = renderToStaticMarkup(
      <FileTable rows={[{ tableName: "dbo.Users", fieldCount: 2, readCount: 3, writeCount: 1, referenceCount: 4 }]} />
    );

    expect(summaryHtml).toContain("Status");
    expect(summaryHtml).toContain("completed");
    expect(tableHtml).toContain("dbo.Users");
    expect(tableHtml).toContain("Reads 3 / Writes 1 / References 4");
  });

  it("renders risks, warning summaries, and pagination summary without changing list semantics", () => {
    const risksHtml = renderToStaticMarkup(
      <RiskPanel
        loading={false}
        items={[
          {
            id: "risk-1",
            title: "Dynamic SQL",
            severity: "high",
            sourceFile: "repo.sql",
            lineNumber: 12,
            description: "Runtime SQL assembly detected.",
            recommendation: "Review the generated statement manually.",
            occurrenceCount: 3,
            affectedFileCount: 2,
            sampleLocations: [{ sourceFile: "repo.sql", lineNumber: 12 }],
          },
        ]}
      />
    );
    const warningsHtml = renderToStaticMarkup(
      <WarningSummaryCard
        items={[
          {
            code: "IMPORT_LIMITED_ANALYSIS",
            label: "DFM limited analysis",
            description: "Delphi metadata was imported with limited parsing.",
            count: 10,
            sampleMessages: ["Imported with limited analysis."],
            sampleFiles: ["forms/MainForm.dfm"],
          },
        ]}
      />
    );
    const pagingHtml = renderToStaticMarkup(
      <PaginationControls total={20} page={2} pageCount={4} onPrev={vi.fn()} onNext={vi.fn()} />
    );

    expect(risksHtml).toContain("Dynamic SQL");
    expect(risksHtml).toContain("3 occurrences");
    expect(risksHtml).toContain("Recommendation: Review the generated statement manually.");
    expect(warningsHtml).toContain("DFM limited analysis");
    expect(pagingHtml).toContain("20 total, page 2 of 4");
  });
});
