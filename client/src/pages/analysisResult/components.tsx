import { Download, Loader2, RefreshCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { analysisResultCopy } from "./copy";

export function ReportActions({
  isRefreshing,
  isDownloading,
  canDownload,
  isRunning,
  onRefresh,
  onDownload,
}: {
  isRefreshing: boolean;
  isDownloading: boolean;
  canDownload: boolean;
  isRunning: boolean;
  onRefresh: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button variant="outline" onClick={onRefresh} disabled={isRefreshing}>
        <RefreshCcw className="mr-2 size-4" />
        {analysisResultCopy.actions.refresh}
      </Button>
      <Button onClick={onDownload} disabled={isDownloading || !canDownload || isRunning}>
        {isDownloading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
        {analysisResultCopy.actions.downloadReportZip}
      </Button>
    </div>
  );
}

export function ProjectSummaryCard({
  rows,
}: {
  rows: Array<{ label: string; value: string }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{analysisResultCopy.summary.title}</CardTitle>
        <CardDescription>{analysisResultCopy.summary.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm md:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <span className="text-slate-600">{row.label}</span>
            <span className="font-medium text-slate-950">{row.value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function FileTable({
  rows,
}: {
  rows: Array<{ tableName: string; fieldCount: number; readCount: number; writeCount: number; referenceCount: number }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{analysisResultCopy.summary.fieldTableTitle}</CardTitle>
        <CardDescription>{analysisResultCopy.summary.fieldTableDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {rows.length > 0 ? (
          rows.map((table) => (
            <div key={table.tableName} className="rounded-lg border px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-slate-950">{table.tableName}</span>
                <Badge variant="outline">{analysisResultCopy.summary.fieldsBadge(table.fieldCount)}</Badge>
              </div>
              <p className="text-slate-500">{analysisResultCopy.summary.fieldStats(table.readCount, table.writeCount, table.referenceCount)}</p>
            </div>
          ))
        ) : (
          <p className="text-slate-500">{analysisResultCopy.summary.noFieldTableSummary}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function RiskPanel({
  loading,
  items,
}: {
  loading: boolean;
  items: Array<{ id: number; title: string; severity: string; sourceFile: string | null; lineNumber: number | null; description: string | null; recommendation: string | null }>;
}) {
  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-6 animate-spin text-slate-600" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-slate-600">{analysisResultCopy.risk.empty}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((risk) => (
        <Card key={risk.id}>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="text-lg">{risk.title}</CardTitle>
              <Badge variant={risk.severity === "critical" || risk.severity === "high" ? "destructive" : "secondary"}>{risk.severity}</Badge>
            </div>
            <CardDescription>
              {risk.sourceFile ?? analysisResultCopy.risk.unknownSource}
              {risk.lineNumber ? `:${risk.lineNumber}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            <p>{risk.description ?? analysisResultCopy.risk.noDescription}</p>
            {risk.recommendation ? <p className="text-slate-600">{analysisResultCopy.risk.recommendation(risk.recommendation)}</p> : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function PaginationControls({
  total,
  page,
  pageCount,
  onPrev,
  onNext,
}: {
  total: number;
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-slate-600">
      <p>
        {analysisResultCopy.pagination.summary(total, page, pageCount)}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onPrev} disabled={page <= 1}>
          {analysisResultCopy.pagination.previous}
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={pageCount === 0 || page >= pageCount}>
          {analysisResultCopy.pagination.next}
        </Button>
      </div>
    </div>
  );
}
