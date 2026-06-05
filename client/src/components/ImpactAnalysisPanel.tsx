import { useState } from "react";
import { AlertCircle, GitBranch, Info, Loader2, Search, TreePine } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getAffectedComponentCount } from "./impactAnalysisSummary";
import { buildImpactSections, DEFAULT_IMPACT_SECTION_LIMIT } from "./impactAnalysisSections";
import type { ImpactTargetType } from "@shared/contracts";
import { t } from "@/locales";
import { impactTargetTypeLabel } from "@/locales/uiLabels";

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
    { enabled: searchTarget.trim().length > 0, refetchOnWindowFocus: false }
  );

  const handleAnalyze = () => {
    const nextTarget = target.trim();
    if (!nextTarget) return;

    setSearchTarget(nextTarget);
    setSearchType(type);
  };

  const impactSections = impactQuery.data ? buildImpactSections(impactQuery.data, DEFAULT_IMPACT_SECTION_LIMIT) : [];

  const toneClassNames: Record<NonNullable<ReturnType<typeof buildImpactSections>[number]["items"][number]["tone"]>, string> = {
    default: "text-slate-700",
    symbol: "font-mono text-blue-600",
    field: "font-mono text-emerald-600",
    rule: "font-mono text-amber-700",
    risk: "font-mono text-rose-700",
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("impact.title")}</CardTitle>
          <CardDescription>{t("impact.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert className="mb-4">
            <Info className="h-4 w-4" />
            <AlertTitle>{t("impact.disclaimerTitle")}</AlertTitle>
            <AlertDescription>{t("impact.disclaimerDescription")}</AlertDescription>
          </Alert>
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
              <Input
                placeholder={t("impact.placeholder")}
                className="pl-9"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && handleAnalyze()}
              />
            </div>
            <Select value={type} onValueChange={(value) => setType(value as ImpactTargetType)}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder={t("impact.selectType")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("impact.auto")}</SelectItem>
                <SelectItem value="symbol">{t("impact.symbol")}</SelectItem>
                <SelectItem value="file">{t("impact.file")}</SelectItem>
                <SelectItem value="sql_table">{t("impact.sqlTable")}</SelectItem>
                <SelectItem value="sql_field">{t("impact.sqlField")}</SelectItem>
                <SelectItem value="risk">{t("impact.risk")}</SelectItem>
                <SelectItem value="rule">{t("impact.rule")}</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleAnalyze} disabled={impactQuery.isFetching}>
              {impactQuery.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t("impact.analyze")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {impactQuery.isLoading && searchTarget ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      ) : null}

      {impactQuery.error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("impact.errorTitle")}</AlertTitle>
          <AlertDescription>{impactQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {impactQuery.data ? (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-500">{t("impact.target")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{impactQuery.data.target}</div>
                <Badge variant="outline" className="mt-1 capitalize">
                  {impactTargetTypeLabel(impactQuery.data.targetType)}
                </Badge>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-500">{t("impact.affectedComponents")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{getAffectedComponentCount(impactQuery.data)}</div>
                <p className="mt-1 text-xs text-slate-500">
                  {t("impact.acrossFiles", { count: impactQuery.data.affectedFiles.length })}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-500">{t("impact.confidence")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{(impactQuery.data.confidence * 100).toFixed(0)}%</div>
                <p className="mt-1 text-xs text-slate-500">{t("impact.deterministicMatch")}</p>
              </CardContent>
            </Card>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>{t("impact.summary")}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{impactQuery.data.summary}</p>
              {impactSections.some((section) => section.hiddenCount > 0) ? (
                <p className="text-xs text-slate-500">
                  {t("impact.capped", { limit: DEFAULT_IMPACT_SECTION_LIMIT })}
                </p>
              ) : null}
            </AlertDescription>
          </Alert>

          {impactQuery.data.warnings.length > 0 ? (
            <Alert variant="warning">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t("impact.warnings")}</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 list-disc pl-4">
                  {impactQuery.data.warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TreePine className="h-5 w-5 text-slate-500" />
                  {t("impact.affectedTree")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="font-medium text-slate-900">{impactQuery.data.target}</div>
                  <div className="space-y-4 border-l-2 border-slate-100 pl-4">
                    {impactSections.length > 0 ? (
                      impactSections.map((section) => (
                        <div key={section.id}>
                          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
                            <span>{section.title}</span>
                            <Badge variant="outline">{section.count}</Badge>
                            {section.hiddenCount > 0 ? (
                              <span className="text-[11px] normal-case text-slate-400">
                                {t("impact.showingMore", { shown: section.items.length, hidden: section.hiddenCount })}
                              </span>
                            ) : null}
                          </div>
                          <div className="space-y-1">
                            {section.items.map((item) => (
                              <div key={item.key} className="flex items-start gap-2 text-sm">
                                <span className="mt-0.5 text-slate-400">-&gt;</span>
                                <div className="min-w-0">
                                  <div className={toneClassNames[item.tone ?? "default"]}>{item.label}</div>
                                  {item.meta ? <div className="truncate text-xs text-slate-400">{item.meta}</div> : null}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-sm italic text-slate-400">{t("impact.noDirectImpacts")}</div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <GitBranch className="h-5 w-5 text-slate-500" />
                  {t("impact.dependencyChains")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {impactQuery.data.dependencyChains.length > 0 ? (
                  <div className="space-y-3">
                    {impactQuery.data.dependencyChains.map((chain, index) => (
                      <div key={`${chain.join("->")}-${index}`} className="rounded border border-slate-100 bg-slate-50 p-2 text-sm">
                        {chain.map((step, stepIndex) => (
                          <span key={`${step}-${stepIndex}`}>
                            <span className="font-mono font-medium">{step}</span>
                            {stepIndex < chain.length - 1 ? <span className="mx-2 text-slate-400">-&gt;</span> : null}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm italic text-slate-400">{t("impact.noDependencyChains")}</div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}

      {!searchTarget && !impactQuery.isFetching ? (
        <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed bg-slate-50/50 py-12 text-center">
          <div className="mb-4 rounded-full bg-slate-100 p-3">
            <Search className="h-6 w-6 text-slate-400" />
          </div>
          <h3 className="text-lg font-medium text-slate-900">{t("impact.startTitle")}</h3>
          <p className="mt-1 max-w-sm text-sm text-slate-500">{t("impact.startDescription")}</p>
        </div>
      ) : null}
    </div>
  );
}
