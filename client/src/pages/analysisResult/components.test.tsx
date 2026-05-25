import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FileTable, PaginationControls, ProjectSummaryCard, ReportActions, RiskPanel } from "./components";

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

    expect(html).toContain("Download Report ZIP");
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
    expect(tableHtml).toContain("reads 3 / writes 1 / references 4");
  });

  it("renders risks and pagination summary without changing list semantics", () => {
    const risksHtml = renderToStaticMarkup(
      <RiskPanel
        loading={false}
        items={[
          {
            id: 1,
            title: "Dynamic SQL",
            severity: "high",
            sourceFile: "repo.sql",
            lineNumber: 12,
            description: "Runtime SQL assembly detected.",
            recommendation: "Review the generated statement manually.",
          },
        ]}
      />
    );
    const pagingHtml = renderToStaticMarkup(
      <PaginationControls total={20} page={2} pageCount={4} onPrev={vi.fn()} onNext={vi.fn()} />
    );

    expect(risksHtml).toContain("Dynamic SQL");
    expect(risksHtml).toContain("Review the generated statement manually.");
    expect(pagingHtml).toContain("Total 20 items, page 2 / 4");
  });
});
