import { useState } from "react";
import { Search, Loader2, AlertCircle, TreePine, GitBranch, Info } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { ImpactTargetType } from "@shared/contracts";

interface ImpactAnalysisPanelProps {
  projectId: number;
}

export function ImpactAnalysisPanel({ projectId }: ImpactAnalysisPanelProps) {
  const [target, setTarget] = useState("");
  const [type, setType] = useState<ImpactTargetType>("auto");
  const [searchTarget, setSearchTarget] = useState("");
  const [searchType, setSearchType] = useState<ImpactTargetType>("auto");

  const impactQuery = trpc.analysis.getImpact.useQuery(
    { projectId, target: searchTarget, type: searchType },
    { enabled: !!searchTarget, refetchOnWindowFocus: false }
  );

  const handleAnalyze = () => {
    if (!target.trim()) return;
    setSearchTarget(target);
    setSearchType(type);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Impact Analysis</CardTitle>
          <CardDescription>
            Understand what may break before changing legacy code. Enter a symbol, table, or field name to trace its dependencies.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
              <Input
                placeholder="e.g. EB_SPECI, UpdateContract, sample.sql"
                className="pl-9"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
              />
            </div>
            <Select value={type} onValueChange={(v) => setType(v as ImpactTargetType)}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto Detect</SelectItem>
                <SelectItem value="symbol">Symbol</SelectItem>
                <SelectItem value="file">File</SelectItem>
                <SelectItem value="sql_table">SQL Table</SelectItem>
                <SelectItem value="sql_field">SQL Field</SelectItem>
                <SelectItem value="risk">Risk</SelectItem>
                <SelectItem value="rule">Business Rule</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleAnalyze} disabled={impactQuery.isFetching}>
              {impactQuery.isFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Analyze
            </Button>
          </div>
        </CardContent>
      </Card>

      {impactQuery.isLoading && searchTarget && (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      )}

      {impactQuery.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{impactQuery.error.message}</AlertDescription>
        </Alert>
      )}

      {impactQuery.data && (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-500">Target</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{impactQuery.data.target}</div>
                <Badge variant="outline" className="mt-1 capitalize">
                  {impactQuery.data.targetType}
                </Badge>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-500">Affected Components</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {impactQuery.data.affectedFiles.length +
                    impactQuery.data.affectedSymbols.length +
                    impactQuery.data.affectedTables.length +
                    impactQuery.data.affectedFields.length}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Across {impactQuery.data.affectedFiles.length} files
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-500">Confidence</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{(impactQuery.data.confidence * 100).toFixed(0)}%</div>
                <p className="text-xs text-slate-500 mt-1">Deterministic match</p>
              </CardContent>
            </Card>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>Summary</AlertTitle>
            <AlertDescription>{impactQuery.data.summary}</AlertDescription>
          </Alert>

          {impactQuery.data.warnings.length > 0 && (
            <Alert variant="warning" className="bg-amber-50 border-amber-200 text-amber-800">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Warnings</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4 mt-1">
                  {impactQuery.data.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TreePine className="h-5 w-5 text-slate-500" />
                  Impact Tree
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="font-medium text-slate-900">{impactQuery.data.target}</div>
                  <div className="pl-4 border-l-2 border-slate-100 space-y-3">
                    {impactQuery.data.affectedSymbols.length > 0 && (
                      <div>
                        <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Used by Symbols</div>
                        <div className="space-y-1">
                          {impactQuery.data.affectedSymbols.map((s, i) => (
                            <div key={i} className="text-sm flex items-center gap-2">
                              <span className="text-slate-400">├─</span>
                              <span className="font-mono text-blue-600">{s.name}</span>
                              <span className="text-slate-400 text-xs">({s.file})</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {impactQuery.data.affectedFields.length > 0 && (
                      <div>
                        <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Related Fields</div>
                        <div className="space-y-1">
                          {impactQuery.data.affectedFields.map((f, i) => (
                            <div key={i} className="text-sm flex items-center gap-2">
                              <span className="text-slate-400">├─</span>
                              <span className="font-mono text-emerald-600">{f.table}.{f.field}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {impactQuery.data.affectedFiles.length > 0 && impactQuery.data.affectedSymbols.length === 0 && (
                      <div>
                        <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Affected Files</div>
                        <div className="space-y-1">
                          {impactQuery.data.affectedFiles.map((f, i) => (
                            <div key={i} className="text-sm flex items-center gap-2">
                              <span className="text-slate-400">├─</span>
                              <span className="text-slate-700">{f}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {impactQuery.data.affectedSymbols.length === 0 && 
                     impactQuery.data.affectedFields.length === 0 && 
                     impactQuery.data.affectedFiles.length === 0 && (
                      <div className="text-sm text-slate-400 italic">No direct impacts found.</div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <GitBranch className="h-5 w-5 text-slate-500" />
                  Dependency Chains
                </CardTitle>
              </CardHeader>
              <CardContent>
                {impactQuery.data.dependencyChains.length > 0 ? (
                  <div className="space-y-3">
                    {impactQuery.data.dependencyChains.map((chain, i) => (
                      <div key={i} className="text-sm p-2 bg-slate-50 rounded border border-slate-100">
                        {chain.map((step, si) => (
                          <span key={si}>
                            <span className="font-mono font-medium">{step}</span>
                            {si < chain.length - 1 && <span className="mx-2 text-slate-400">→</span>}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-slate-400 italic">No dependency chains traced.</div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {!searchTarget && !impactQuery.isFetching && (
        <div className="flex flex-col items-center justify-center py-12 text-center border-2 border-dashed rounded-lg bg-slate-50/50">
          <div className="rounded-full bg-slate-100 p-3 mb-4">
            <Search className="h-6 w-6 text-slate-400" />
          </div>
          <h3 className="text-lg font-medium text-slate-900">Start Analysis</h3>
          <p className="text-sm text-slate-500 max-w-sm mt-1">
            Enter a target name above and click "Analyze" to see the impact of changes.
          </p>
        </div>
      )}
    </div>
  );
}
