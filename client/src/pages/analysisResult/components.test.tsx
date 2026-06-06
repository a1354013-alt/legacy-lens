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

    expect(html).toContain("下載報告 ZIP");
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
    expect(tableHtml).toContain("讀取 3 / 寫入 1 / 參照 4");
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
            label: "DFM 有限分析",
            description: "部分 Delphi 表單檔僅做有限分析。",
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
    expect(risksHtml).toContain("出現 3 次");
    expect(risksHtml).toContain("Review the generated statement manually.");
    expect(warningsHtml).toContain("DFM 有限分析");
    expect(pagingHtml).toContain("共 20 筆，第 2 / 4 頁");
  });
});
