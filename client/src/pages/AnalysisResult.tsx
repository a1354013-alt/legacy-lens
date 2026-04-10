import { useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Download, FileText, Loader2, RefreshCcw, ShieldAlert, TriangleAlert } from "lucide-react";
import { analysisStatusLabels, projectStatusLabels } from "@shared/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

function downloadBase64File(base64: string, fileName: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function renderDocumentPreview(content: string | null | undefined) {
  if (!content) {
    return "No persisted document is available yet.";
  }
  return content.split("\n").slice(0, 12).join("\n");
}

export default function AnalysisResult() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/projects/:id/analysis");
  const projectId = params?.id ? Number(params.id) : Number.NaN;
  const [activeTab, setActiveTab] = useState("overview");
  const utils = trpc.useUtils();

  const projectQuery = trpc.projects.getById.useQuery(projectId, {
    enabled: Number.isFinite(projectId),
    refetchOnWindowFocus: false,
  });

  const pollEnabled =
    projectQuery.data?.status === "analyzing" ||
    projectQuery.data?.analysisStatus === "pending" ||
    projectQuery.data?.analysisStatus === "processing";

  const snapshotQuery = trpc.analysis.getSnapshot.useQuery(projectId, {
    enabled: Number.isFinite(projectId),
    refetchInterval: pollEnabled ? 2000 : false,
    refetchOnWindowFocus: false,
  });

  const reportDownloadQuery = trpc.analysis.downloadReport.useQuery(
    { projectId, format: "zip" },
    { enabled: false }
  );

  const triggerAnalysisMutation = trpc.analysis.trigger.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.projects.getById.invalidate(projectId), utils.analysis.getSnapshot.invalidate(projectId)]);
    },
  });

  const isLoading = projectQuery.isLoading || snapshotQuery.isLoading;
  const project = projectQuery.data;
  const snapshot = snapshotQuery.data;
  const report = snapshot?.report;
  const metrics = report?.summaryJson;

  const criticalRisks = useMemo(
    () => snapshot?.risks.filter((risk) => risk.severity === "critical").length ?? 0,
    [snapshot?.risks]
  );

  const canRunAnalysis = project ? ["ready", "failed", "completed"].includes(project.status) : false;
  const isAnalyzing = project?.status === "analyzing" || report?.status === "processing";

  const handleRunAnalysis = async () => {
    if (!project) return;
    try {
      const result = await triggerAnalysisMutation.mutateAsync(project.id);
      toast.success(
        result.status === "partial"
          ? "Analysis completed with warnings. Review heuristic output before using it as source-of-truth."
          : "Analysis completed."
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Analysis failed.");
    }
  };

  const handleDownloadReport = async () => {
    try {
      const result = await reportDownloadQuery.refetch();
      if (!result.data) {
        toast.error("The persisted report archive is not ready yet.");
        return;
      }
      downloadBase64File(result.data.base64, result.data.fileName, result.data.mimeType);
      toast.success("Report downloaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to download report.");
    }
  };

  if (!Number.isFinite(projectId)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Alert variant="destructive">
          <AlertTitle>Invalid project identifier</AlertTitle>
          <AlertDescription>The requested project id is not valid.</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="size-10 animate-spin text-slate-600" />
      </div>
    );
  }

  if (projectQuery.error || !project) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <Alert variant="destructive">
          <AlertTitle>Project not available</AlertTitle>
          <AlertDescription>{projectQuery.error?.message ?? "The project could not be loaded."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" onClick={() => setLocation("/")}>
              <ArrowLeft className="mr-2 size-4" />
              Back to projects
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-slate-950">{project.name}</h1>
              <p className="text-sm text-slate-600">The report view and ZIP export both come from the same persisted analysis result row.</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => snapshotQuery.refetch()} disabled={snapshotQuery.isFetching}>
              <RefreshCcw className="mr-2 size-4" />
              Refresh
            </Button>
            <Button onClick={handleDownloadReport} disabled={reportDownloadQuery.isFetching || !report || isAnalyzing}>
              {reportDownloadQuery.isFetching ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
              Download ZIP
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={project.status === "failed" ? "destructive" : "secondary"}>Project: {projectStatusLabels[project.status]}</Badge>
          <Badge variant={report?.status === "failed" ? "destructive" : report?.status === "completed" ? "default" : "secondary"}>
            Analysis: {analysisStatusLabels[report?.status ?? "pending"]}
          </Badge>
          <Badge variant="outline">Language: {project.language.toUpperCase()}</Badge>
          <Badge variant="outline">Source: {project.sourceType === "git" ? "Git" : "ZIP"}</Badge>
        </div>

        <Alert>
          <AlertTitle>Heuristic analysis</AlertTitle>
          <AlertDescription>Go, SQL, and Delphi parsing in this release is heuristic. Review output before treating it as compiler-grade semantic truth.</AlertDescription>
        </Alert>

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>Latest workflow error</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {report?.status === "partial" ? (
          <Alert>
            <AlertTitle>Completed with warnings</AlertTitle>
            <AlertDescription>
              {(report.warningsJson ?? []).map((warning) => warning.message).join(" | ") || "Some files were skipped or analyzed with reduced confidence."}
            </AlertDescription>
          </Alert>
        ) : null}

        {isAnalyzing ? (
          <Card>
            <CardHeader>
              <CardTitle>Analysis in progress</CardTitle>
              <CardDescription>This page is polling the server every 2 seconds until the workflow reaches a terminal state.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-600">
              <p>Project workflow: {project.status}</p>
              <p>Analysis row: {report?.status ?? "pending"}</p>
            </CardContent>
          </Card>
        ) : null}

        {!report && !isAnalyzing ? (
          <Card>
            <CardHeader>
              <CardTitle>No analysis result yet</CardTitle>
              <CardDescription>Run analysis to generate persisted artifacts, UI snapshots, and downloadable report content.</CardDescription>
            </CardHeader>
            <CardContent>
              {canRunAnalysis ? (
                <Button onClick={handleRunAnalysis} disabled={triggerAnalysisMutation.isPending}>
                  {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <TriangleAlert className="mr-2 size-4" />}
                  Run analysis
                </Button>
              ) : (
                <p className="text-sm text-slate-600">The current project state does not allow analysis right now.</p>
              )}
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard title="Imported files" value={metrics?.fileCount ?? 0} />
          <MetricCard title="Analyzed files" value={metrics?.analyzedFileCount ?? 0} />
          <MetricCard title="Skipped files" value={metrics?.skippedFileCount ?? 0} emphasis={(metrics?.skippedFileCount ?? 0) > 0 ? "danger" : "default"} />
          <MetricCard title="Degraded files" value={metrics?.degradedFileCount ?? 0} emphasis={(metrics?.degradedFileCount ?? 0) > 0 ? "danger" : "default"} />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="risks">Risks</TabsTrigger>
            <TabsTrigger value="symbols">Symbols</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Analysis summary</CardTitle>
                <CardDescription>These counts come from the persisted analysis result snapshot.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm md:grid-cols-2">
                <SummaryRow label="Project status" value={projectStatusLabels[project.status]} />
                <SummaryRow label="Analysis status" value={analysisStatusLabels[report?.status ?? "pending"]} />
                <SummaryRow label="Imported files" value={String(metrics?.fileCount ?? 0)} />
                <SummaryRow label="Eligible files" value={String(metrics?.eligibleFileCount ?? 0)} />
                <SummaryRow label="Analyzed files" value={String(metrics?.analyzedFileCount ?? 0)} />
                <SummaryRow label="Skipped files" value={String(metrics?.skippedFileCount ?? 0)} />
                <SummaryRow label="Heuristic files" value={String(metrics?.heuristicFileCount ?? 0)} />
                <SummaryRow label="Degraded files" value={String(metrics?.degradedFileCount ?? 0)} />
                <SummaryRow label="Derived rules" value={String(metrics?.ruleCount ?? snapshot?.rules.length ?? 0)} />
                <SummaryRow label="Critical risks" value={String(criticalRisks)} />
              </CardContent>
            </Card>

            {(report?.warningsJson?.length ?? 0) > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Persisted warnings</CardTitle>
                  <CardDescription>These warnings explain why the result is partial or heuristic.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-slate-700">
                  {(report?.warningsJson ?? []).map((warning, index) => (
                    <div key={`${warning.code}-${warning.filePath ?? index}`} className="rounded-lg border px-3 py-2">
                      <p className="font-medium text-slate-950">{warning.code}</p>
                      <p>{warning.message}</p>
                      {warning.filePath ? <p className="text-slate-500">{warning.filePath}</p> : null}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            {canRunAnalysis ? (
              <Card>
                <CardHeader>
                  <CardTitle>Re-run analysis</CardTitle>
                  <CardDescription>Use this when imported files changed or when you want to regenerate the persisted analysis snapshot.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={handleRunAnalysis} disabled={triggerAnalysisMutation.isPending}>
                    {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldAlert className="mr-2 size-4" />}
                    Run analysis
                  </Button>
                </CardContent>
              </Card>
            ) : null}
          </TabsContent>

          <TabsContent value="risks" className="space-y-4">
            {snapshot?.risks.length ? (
              snapshot.risks.map((risk) => (
                <Card key={risk.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-4">
                      <CardTitle className="text-lg">{risk.title}</CardTitle>
                      <Badge variant={risk.severity === "critical" || risk.severity === "high" ? "destructive" : "secondary"}>{risk.severity}</Badge>
                    </div>
                    <CardDescription>
                      {risk.sourceFile ?? "unknown"}:{risk.lineNumber ?? "?"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm text-slate-700">
                    <p>{risk.description ?? "No description provided."}</p>
                    {risk.recommendation ? <p className="text-slate-600">Recommendation: {risk.recommendation}</p> : null}
                  </CardContent>
                </Card>
              ))
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-slate-600">No persisted risks were found for this project.</CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="symbols" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Symbols and fields</CardTitle>
                <CardDescription>This view is sourced from the persisted database snapshot rather than recomputing in the browser.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 rounded-lg border p-4">
                  <h3 className="font-medium text-slate-950">Symbols</h3>
                  <div className="space-y-2 text-sm">
                    {(snapshot?.symbols.slice(0, 12) ?? []).map((symbol) => (
                      <div key={symbol.id} className="flex items-center justify-between gap-3">
                        <span className="truncate">{symbol.name}</span>
                        <Badge variant="outline">{symbol.type}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border p-4">
                  <h3 className="font-medium text-slate-950">Fields</h3>
                  <div className="space-y-2 text-sm">
                    {(snapshot?.fields.slice(0, 12) ?? []).map((field) => (
                      <div key={field.id} className="flex items-center justify-between gap-3">
                        <span className="truncate">
                          {field.tableName}.{field.fieldName}
                        </span>
                        <Badge variant="outline">{field.fieldType ?? "unknown"}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="documents" className="grid gap-4 lg:grid-cols-2">
            <DocumentCard title="FLOW.md" description="Call-flow summary" content={renderDocumentPreview(report?.flowMarkdown)} />
            <DocumentCard title="DATA_DEPENDENCY.md" description="Field read/write summary" content={renderDocumentPreview(report?.dataDependencyMarkdown)} />
            <DocumentCard title="RISKS.md" description="Risk register" content={renderDocumentPreview(report?.risksMarkdown)} />
            <DocumentCard title="RULES.yaml" description="Derived rules" content={renderDocumentPreview(report?.rulesYaml)} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function MetricCard({
  title,
  value,
  emphasis = "default",
}: {
  title: string;
  value: number;
  emphasis?: "default" | "danger";
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-semibold ${emphasis === "danger" ? "text-red-600" : "text-slate-950"}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <span className="text-slate-600">{label}</span>
      <span className="font-medium text-slate-950">{value}</span>
    </div>
  );
}

function DocumentCard({ title, description, content }: { title: string; description: string; content: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileText className="size-4" />
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-6 text-slate-100">{content}</pre>
      </CardContent>
    </Card>
  );
}
