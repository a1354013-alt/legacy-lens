import { useLocation, useRoute } from "wouter";
import { ArrowLeft, FileText, Loader2, ShieldAlert } from "lucide-react";
import {
  analysisStatusLabels,
  dependencyKinds,
  dependencyTargetKinds,
  fieldDependencyOperationTypes,
  projectJobStatusLabels,
  projectJobTypeLabels,
  projectStatusLabels,
  riskSeverities,
  ruleTypes,
  symbolKinds,
} from "@shared/contracts";
import { ImpactAnalysisPanel } from "@/components/ImpactAnalysisPanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileTable, PaginationControls, ProjectSummaryCard, ReportActions, RiskPanel } from "./analysisResult/components";
import { useAnalysisResultModel } from "./analysisResult/useAnalysisResultModel";

function renderDocumentPreview(content: string | null | undefined) {
  if (!content) {
    return "No document content is available yet.";
  }

  return content.split("\n").slice(0, 12).join("\n");
}

export default function AnalysisResult() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/projects/:id/analysis");
  const projectId = params?.id ? Number(params.id) : Number.NaN;
  const {
    activeTab,
    setActiveTab,
    symbolSearch,
    setSymbolSearch,
    symbolKind,
    setSymbolKind,
    symbolPage,
    setSymbolPage,
    fieldSearch,
    setFieldSearch,
    fieldTable,
    setFieldTable,
    fieldPage,
    setFieldPage,
    riskSearch,
    setRiskSearch,
    riskSeverity,
    setRiskSeverity,
    riskPage,
    setRiskPage,
    ruleSearch,
    setRuleSearch,
    ruleType,
    setRuleType,
    rulePage,
    setRulePage,
    dependencySearch,
    setDependencySearch,
    dependencyType,
    setDependencyType,
    dependencyTargetKind,
    setDependencyTargetKind,
    dependencyPage,
    setDependencyPage,
    fieldDependencySearch,
    setFieldDependencySearch,
    fieldDependencyTable,
    setFieldDependencyTable,
    fieldDependencyOperationType,
    setFieldDependencyOperationType,
    fieldDependencyPage,
    setFieldDependencyPage,
    isReportDownloading,
    projectQuery,
    snapshotQuery,
    symbolsQuery,
    fieldsQuery,
    risksQuery,
    rulesQuery,
    dependenciesQuery,
    fieldDependenciesQuery,
    triggerAnalysisMutation,
    isLoading,
    project,
    snapshot,
    report,
    metrics,
    analysisStatus,
    viewState,
    importWarnings,
    canRunAnalysis,
    canDownloadReport,
    handleRunAnalysis,
    handleDownloadReport,
  } = useAnalysisResultModel(projectId);

  if (!Number.isFinite(projectId)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <Alert variant="destructive">
          <AlertTitle>Invalid project</AlertTitle>
          <AlertDescription>The project id in the URL is invalid.</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="size-10 animate-spin text-slate-600" aria-label="analysis-loading" />
      </div>
    );
  }

  if (projectQuery.error || !project) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <Alert variant="destructive">
          <AlertTitle>Project unavailable</AlertTitle>
          <AlertDescription>{projectQuery.error?.message ?? "Unable to load the requested project."}</AlertDescription>
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
              <p className="text-sm text-slate-600">Persisted analysis snapshot, paged evidence, and export controls.</p>
            </div>
          </div>
          <ReportActions
            isRefreshing={projectQuery.isFetching || snapshotQuery.isFetching}
            isDownloading={isReportDownloading}
            canDownload={canDownloadReport}
            isRunning={viewState === "running"}
            onRefresh={() => void Promise.all([projectQuery.refetch(), snapshotQuery.refetch()])}
            onDownload={() => void handleDownloadReport()}
          />
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={project.status === "failed" ? "destructive" : "secondary"}>Project: {projectStatusLabels[project.status]}</Badge>
          <Badge variant={viewState === "failed" ? "destructive" : report?.status === "completed" || report?.status === "partial" ? "default" : "secondary"}>
            Analysis: {analysisStatusLabels[analysisStatus]}
          </Badge>
          <Badge variant="outline">Focus: {project.language.toUpperCase()}</Badge>
          <Badge variant="outline">Source: {project.sourceType === "git" ? "Git" : "ZIP"}</Badge>
          {project.latestJob ? (
            <Badge variant="outline">
              Job: {projectJobTypeLabels[project.latestJob.type]} / {projectJobStatusLabels[project.latestJob.status]} / {project.latestJob.progress}%
            </Badge>
          ) : null}
        </div>

        <Alert>
          <AlertTitle>Review posture</AlertTitle>
          <AlertDescription>
            Legacy Lens is a legacy impact review assistant. Results are heuristic for Go, SQL, Delphi, and DFM analysis and should support, not replace, human review.
          </AlertDescription>
        </Alert>

        {project.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>Latest project error</AlertTitle>
            <AlertDescription>{project.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {project.latestJob?.status === "failed" && project.latestJob.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>Latest job failed</AlertTitle>
            <AlertDescription>{project.latestJob.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {(viewState === "queued" || viewState === "running") && project.latestJob ? (
          <Card data-testid="analysis-running">
            <CardHeader>
              <CardTitle>{viewState === "queued" ? "Analysis queued" : "Analysis running"}</CardTitle>
              <CardDescription>The backend job is still progressing. Snapshot data will refresh automatically.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-700">
              <p>Job type: {projectJobTypeLabels[project.latestJob.type]}</p>
              <p>Status: {projectJobStatusLabels[project.latestJob.status]}</p>
              <p>Progress: {project.latestJob.progress}%</p>
            </CardContent>
          </Card>
        ) : null}

        {!report && viewState === "idle" ? (
          <Card>
            <CardHeader>
              <CardTitle>No analysis report yet</CardTitle>
              <CardDescription>Import the project source and run analysis to create the persisted report snapshot.</CardDescription>
            </CardHeader>
            <CardContent>
              {canRunAnalysis ? (
                <Button onClick={() => void handleRunAnalysis()} disabled={triggerAnalysisMutation.isPending}>
                  {triggerAnalysisMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldAlert className="mr-2 size-4" />}
                  Run analysis
                </Button>
              ) : (
                <p className="text-sm text-slate-600">This project is not in a runnable state yet.</p>
              )}
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard title="Files" value={metrics?.fileCount ?? snapshot?.totals.files ?? 0} />
          <MetricCard title="Symbols" value={metrics?.symbolCount ?? snapshot?.totals.symbols ?? 0} />
          <MetricCard title="Risks" value={metrics?.riskCount ?? snapshot?.totals.risks ?? 0} emphasis={(metrics?.riskCount ?? snapshot?.totals.risks ?? 0) > 0 ? "danger" : "default"} />
          <MetricCard title="Rules" value={metrics?.ruleCount ?? snapshot?.totals.rules ?? 0} />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="impact">Impact</TabsTrigger>
            <TabsTrigger value="symbols">Symbols</TabsTrigger>
            <TabsTrigger value="fields">Fields</TabsTrigger>
            <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
            <TabsTrigger value="fieldDependencies">Field Dependencies</TabsTrigger>
            <TabsTrigger value="risks">Risks</TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <ProjectSummaryCard
              rows={[
                { label: "Project status", value: projectStatusLabels[project.status] },
                { label: "Analysis status", value: analysisStatusLabels[analysisStatus] },
                { label: "Eligible files", value: String(metrics?.eligibleFileCount ?? 0) },
                { label: "Analyzed files", value: String(metrics?.analyzedFileCount ?? 0) },
                { label: "Skipped files", value: String(metrics?.skippedFileCount ?? 0) },
                { label: "Field dependencies", value: String(metrics?.fieldDependencyCount ?? snapshot?.totals.fieldDependencies ?? 0) },
              ]}
            />

            {importWarnings.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Import warnings</CardTitle>
                  <CardDescription>These warnings were recorded during import and are included in the persisted snapshot.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-slate-700">
                  {importWarnings.map((warning, index) => (
                    <div key={`${warning.code}-${warning.filePath ?? index}`} className="rounded-lg border px-3 py-2">
                      <p className="font-medium text-slate-950">{warning.code}</p>
                      <p>{warning.message}</p>
                      {warning.filePath ? <p className="text-slate-500">{warning.filePath}</p> : null}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-3">
              <SimpleListCard
                title="Top Symbols"
                items={(snapshot?.topSymbols ?? []).map((item) => `${item.name} (${item.type})${item.filePath ? ` - ${item.filePath}` : ""}`)}
                emptyText="No symbols were highlighted."
              />
              <SimpleListCard
                title="Top Risks"
                items={(snapshot?.topRisks ?? []).map((item) => `[${item.severity}] ${item.title}`)}
                emptyText="No risks were highlighted."
              />
              <SimpleListCard
                title="Top Rules"
                items={(snapshot?.topRules ?? []).map((item) => `${item.name} (${item.ruleType})`)}
                emptyText="No rules were highlighted."
              />
            </div>

            <FileTable rows={snapshot?.fieldTables ?? []} />
          </TabsContent>

          <TabsContent value="impact">
            <ImpactAnalysisPanel projectId={projectId} />
          </TabsContent>

          <TabsContent value="symbols" className="space-y-4">
            <FilterCard title="Symbols" description="Filter persisted symbols by name or kind.">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={symbolSearch} onChange={(event) => { setSymbolSearch(event.target.value); setSymbolPage(1); }} placeholder="Search symbol name" />
                <Select value={symbolKind} onValueChange={(value) => { setSymbolKind(value); setSymbolPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="Kind" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All kinds</SelectItem>
                    {symbolKinds.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={symbolsQuery.data?.total ?? 0} page={symbolsQuery.data?.page ?? symbolPage} pageCount={symbolsQuery.data?.pageCount ?? 0} onPrev={() => setSymbolPage((value) => Math.max(1, value - 1))} onNext={() => setSymbolPage((value) => value + 1)} />
            <ListCard
              loading={symbolsQuery.isLoading}
              items={(symbolsQuery.data?.items ?? []).map((symbol) => (
                <div key={symbol.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{symbol.name}</span>
                    <Badge variant="outline">{symbol.type}</Badge>
                  </div>
                  <p className="text-slate-600">{symbol.filePath ?? "unknown file"}</p>
                  <p className="text-slate-500">line {symbol.startLine} - {symbol.endLine}</p>
                </div>
              ))}
              emptyText="No symbols matched the current filters."
            />
          </TabsContent>

          <TabsContent value="fields" className="space-y-4">
            <FilterCard title="Fields" description="Filter persisted field evidence by table or name.">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={fieldSearch} onChange={(event) => { setFieldSearch(event.target.value); setFieldPage(1); }} placeholder="Search table or field" />
                <Select value={fieldTable} onValueChange={(value) => { setFieldTable(value); setFieldPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="Table" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All tables</SelectItem>
                    {(snapshot?.fieldTables ?? []).map((table) => <SelectItem key={table.tableName} value={table.tableName}>{table.tableName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={fieldsQuery.data?.total ?? 0} page={fieldsQuery.data?.page ?? fieldPage} pageCount={fieldsQuery.data?.pageCount ?? 0} onPrev={() => setFieldPage((value) => Math.max(1, value - 1))} onNext={() => setFieldPage((value) => value + 1)} />
            <ListCard
              loading={fieldsQuery.isLoading}
              items={(fieldsQuery.data?.items ?? []).map((field) => (
                <div key={field.id} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{field.tableName}.{field.fieldName}</span>
                    <Badge variant="outline">{field.fieldType ?? "unknown"}</Badge>
                  </div>
                  <p className="text-slate-500">references {field.referenceCount} / reads {field.readCount} / writes {field.writeCount}</p>
                </div>
              ))}
              emptyText="No fields matched the current filters."
            />
          </TabsContent>

          <TabsContent value="dependencies" className="space-y-4">
            <FilterCard title="Dependencies" description="Inspect symbol-to-symbol and symbol-to-external dependencies.">
              <div className="grid gap-3 md:grid-cols-3">
                <Input value={dependencySearch} onChange={(event) => { setDependencySearch(event.target.value); setDependencyPage(1); }} placeholder="Search source, target, or external name" />
                <Select value={dependencyType} onValueChange={(value) => { setDependencyType(value); setDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="Dependency type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All dependency types</SelectItem>
                    {dependencyKinds.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={dependencyTargetKind} onValueChange={(value) => { setDependencyTargetKind(value); setDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="Target kind" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All target kinds</SelectItem>
                    {dependencyTargetKinds.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={dependenciesQuery.data?.total ?? 0} page={dependenciesQuery.data?.page ?? dependencyPage} pageCount={dependenciesQuery.data?.pageCount ?? 0} onPrev={() => setDependencyPage((value) => Math.max(1, value - 1))} onNext={() => setDependencyPage((value) => value + 1)} />
            <ListCard
              loading={dependenciesQuery.isLoading}
              items={(dependenciesQuery.data?.items ?? []).map((dependency) => (
                <div key={dependency.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{dependency.sourceSymbolName}</span>
                    <Badge variant="outline">{dependency.dependencyType}</Badge>
                  </div>
                  <p className="text-slate-600">target: {dependency.targetSymbolName ?? dependency.targetExternalName ?? "unknown"}</p>
                  <p className="text-slate-500">{dependency.targetKind}{dependency.lineNumber ? ` / line ${dependency.lineNumber}` : ""}</p>
                </div>
              ))}
              emptyText="No dependencies matched the current filters."
            />
          </TabsContent>

          <TabsContent value="fieldDependencies" className="space-y-4">
            <FilterCard title="Field Dependencies" description="Inspect field-level read/write/calculate evidence.">
              <div className="grid gap-3 md:grid-cols-3">
                <Input value={fieldDependencySearch} onChange={(event) => { setFieldDependencySearch(event.target.value); setFieldDependencyPage(1); }} placeholder="Search table, field, symbol, or context" />
                <Select value={fieldDependencyTable} onValueChange={(value) => { setFieldDependencyTable(value); setFieldDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="Table" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All tables</SelectItem>
                    {(snapshot?.fieldTables ?? []).map((table) => <SelectItem key={table.tableName} value={table.tableName}>{table.tableName}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={fieldDependencyOperationType} onValueChange={(value) => { setFieldDependencyOperationType(value); setFieldDependencyPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="Operation" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All operations</SelectItem>
                    {fieldDependencyOperationTypes.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={fieldDependenciesQuery.data?.total ?? 0} page={fieldDependenciesQuery.data?.page ?? fieldDependencyPage} pageCount={fieldDependenciesQuery.data?.pageCount ?? 0} onPrev={() => setFieldDependencyPage((value) => Math.max(1, value - 1))} onNext={() => setFieldDependencyPage((value) => value + 1)} />
            <ListCard
              loading={fieldDependenciesQuery.isLoading}
              items={(fieldDependenciesQuery.data?.items ?? []).map((item) => (
                <div key={item.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{item.tableName}.{item.fieldName}</span>
                    <Badge variant="outline">{item.operationType}</Badge>
                  </div>
                  <p className="text-slate-600">{item.symbolName}</p>
                  <p className="text-slate-500">{item.context ?? "no context"}{item.lineNumber ? ` / line ${item.lineNumber}` : ""}</p>
                </div>
              ))}
              emptyText="No field dependencies matched the current filters."
            />
          </TabsContent>

          <TabsContent value="risks" className="space-y-4">
            <FilterCard title="Risks" description="Review heuristic risks and filter them by severity or search terms.">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={riskSearch} onChange={(event) => { setRiskSearch(event.target.value); setRiskPage(1); }} placeholder="Search title, description, or file" />
                <Select value={riskSeverity} onValueChange={(value) => { setRiskSeverity(value); setRiskPage(1); }}>
                  <SelectTrigger><SelectValue placeholder="Severity" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All severities</SelectItem>
                    {riskSeverities.map((severity) => <SelectItem key={severity} value={severity}>{severity}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={risksQuery.data?.total ?? 0} page={risksQuery.data?.page ?? riskPage} pageCount={risksQuery.data?.pageCount ?? 0} onPrev={() => setRiskPage((value) => Math.max(1, value - 1))} onNext={() => setRiskPage((value) => value + 1)} />
            <RiskPanel loading={risksQuery.isLoading} items={risksQuery.data?.items ?? []} />
          </TabsContent>

          <TabsContent value="rules" className="space-y-4">
            <FilterCard title="Rules" description="Review derived business-rule candidates and supporting metadata.">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Input value={ruleSearch} onChange={(event) => { setRuleSearch(event.target.value); setRulePage(1); }} placeholder="Search rule name or description" />
                <Select value={ruleType} onValueChange={(value) => { setRuleType(value); setRulePage(1); }}>
                  <SelectTrigger><SelectValue placeholder="Rule type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All rule types</SelectItem>
                    {ruleTypes.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </FilterCard>
            <PaginationControls total={rulesQuery.data?.total ?? 0} page={rulesQuery.data?.page ?? rulePage} pageCount={rulesQuery.data?.pageCount ?? 0} onPrev={() => setRulePage((value) => Math.max(1, value - 1))} onNext={() => setRulePage((value) => value + 1)} />
            <ListCard
              loading={rulesQuery.isLoading}
              items={(rulesQuery.data?.items ?? []).map((rule) => (
                <div key={rule.id} className="rounded-lg border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-950">{rule.name}</span>
                    <Badge variant="outline">{rule.ruleType}</Badge>
                  </div>
                  <p className="text-slate-600">{rule.description ?? "No rule description was generated."}</p>
                  <p className="text-slate-500">{rule.sourceFile ?? "unknown file"}{rule.lineNumber ? `:${rule.lineNumber}` : ""}</p>
                </div>
              ))}
              emptyText="No rules matched the current filters."
            />
          </TabsContent>

          <TabsContent value="documents" className="grid gap-4 lg:grid-cols-2">
            <DocumentCard title="FLOW.md" description="Flow summary" content={renderDocumentPreview(report?.flowMarkdown)} />
            <DocumentCard title="DATA_DEPENDENCY.md" description="Field dependency summary" content={renderDocumentPreview(report?.dataDependencyMarkdown)} />
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

function FilterCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ListCard({ loading, items, emptyText }: { loading: boolean; items: React.ReactNode[]; emptyText: string }) {
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
        <CardContent className="py-10 text-center text-sm text-slate-600">{emptyText}</CardContent>
      </Card>
    );
  }

  return <div className="space-y-3">{items}</div>;
}

function SimpleListCard({ title, items, emptyText }: { title: string; items: string[]; emptyText: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {items.length ? items.map((item) => <div key={item} className="rounded-lg border px-3 py-2">{item}</div>) : <p className="text-slate-500">{emptyText}</p>}
      </CardContent>
    </Card>
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
