/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analysisResultCopy } from "./copy";
import { useAnalysisResultModel } from "./useAnalysisResultModel";

const mocks = vi.hoisted(() => {
  const toast = {
    error: vi.fn(),
    success: vi.fn(),
  };
  const flowTraceCalls: unknown[] = [];
  const setBaselineMutate = vi.fn();
  const clearBaselineMutate = vi.fn();

  const emptyPage = { data: { items: [], total: 0, page: 1, pageCount: 0 }, error: null, isLoading: false };
  const query = {
    project: {
      data: {
        id: 1,
        name: "Legacy Demo",
        status: "completed",
        analysisStatus: "completed",
        latestJob: null,
        importWarningsJson: [],
      },
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    },
    snapshot: {
      data: {
        report: {
          id: 101,
          status: "completed",
          summaryJson: { confidence: { score: 88, level: "high", breakdown: [] } },
        },
        importWarnings: [],
      },
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    },
  };

  const trpc = {
    useUtils: () => ({
      projects: { getById: { invalidate: vi.fn() } },
      analysis: {
        getSnapshot: { invalidate: vi.fn() },
        listRuns: { invalidate: vi.fn() },
        getRun: { invalidate: vi.fn() },
        getDiff: { invalidate: vi.fn() },
      },
    }),
    projects: {
      getById: {
        useQuery: vi.fn(() => query.project),
      },
    },
    analysis: {
      getSnapshot: { useQuery: vi.fn(() => query.snapshot) },
      getSymbolsPage: { useQuery: vi.fn(() => emptyPage) },
      getFieldsPage: { useQuery: vi.fn(() => emptyPage) },
      getRisksPage: { useQuery: vi.fn(() => emptyPage) },
      getRulesPage: { useQuery: vi.fn(() => emptyPage) },
      getDependenciesPage: { useQuery: vi.fn(() => ({ ...emptyPage, data: { ...emptyPage.data, summary: {} } })) },
      getFieldDependenciesPage: { useQuery: vi.fn(() => emptyPage) },
      listRuns: { useQuery: vi.fn(() => emptyPage) },
      getRun: { useQuery: vi.fn(() => ({ data: null, error: null, isLoading: false })) },
      getDiff: { useQuery: vi.fn(() => ({ data: null, error: null, isLoading: false })) },
      getFlowTraceSummary: { useQuery: vi.fn(() => ({ data: null, error: null, isLoading: false })) },
      getFlowTracesPage: {
        useQuery: vi.fn((input: unknown) => {
          flowTraceCalls.push(input);
          return emptyPage;
        }),
      },
      setBaseline: {
        useMutation: vi.fn((options: { onError: (error: Error) => void }) => ({
          isPending: false,
          mutate: setBaselineMutate.mockImplementation(() => options.onError(new Error("set baseline failed"))),
        })),
      },
      clearBaseline: {
        useMutation: vi.fn((options: { onError: (error: Error) => void }) => ({
          isPending: false,
          mutate: clearBaselineMutate.mockImplementation(() => options.onError(new Error("clear baseline failed"))),
        })),
      },
      trigger: { useMutation: vi.fn(() => ({ isPending: false, mutateAsync: vi.fn() })) },
    },
  };

  return { clearBaselineMutate, flowTraceCalls, query, setBaselineMutate, toast, trpc };
});

vi.mock("@/lib/trpc", () => ({ trpc: mocks.trpc }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

describe("useAnalysisResultModel high-value interactions", () => {
  beforeEach(() => {
    mocks.toast.error.mockReset();
    mocks.toast.success.mockReset();
    mocks.flowTraceCalls.length = 0;
    mocks.setBaselineMutate.mockClear();
    mocks.clearBaselineMutate.mockClear();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("surfaces set baseline mutation failure", () => {
    const { result } = renderHook(() => useAnalysisResultModel(1));

    act(() => result.current.setBaselineMutation.mutate({ projectId: 1, runId: 55 }));

    expect(mocks.setBaselineMutate).toHaveBeenCalledWith({ projectId: 1, runId: 55 });
    expect(mocks.toast.error).toHaveBeenCalledWith("set baseline failed");
  });

  it("surfaces clear baseline mutation failure", () => {
    const { result } = renderHook(() => useAnalysisResultModel(1));

    act(() => result.current.clearBaselineMutation.mutate(1));

    expect(mocks.clearBaselineMutate).toHaveBeenCalledWith(1);
    expect(mocks.toast.error).toHaveBeenCalledWith("clear baseline failed");
  });

  it("surfaces historical report download failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("no report", { status: 500 }));
    const { result } = renderHook(() => useAnalysisResultModel(1));

    await act(async () => result.current.handleDownloadHistoricalReport(55));

    expect(fetch).toHaveBeenCalledWith("/api/projects/1/report.zip?runId=55", { credentials: "include" });
    expect(mocks.toast.error).toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalledWith(analysisResultCopy.toasts.historicalReportDownloadSucceeded);
  });

  it("surfaces Diff ZIP download failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("no diff", { status: 500 }));
    const { result } = renderHook(() => useAnalysisResultModel(1));

    act(() => {
      result.current.setCompareBaseRunId(55);
      result.current.setCompareRunId(101);
    });
    await waitFor(() => expect(result.current.canDownloadComparison).toBe(true));
    await act(async () => result.current.handleDownloadComparison());

    expect(fetch).toHaveBeenCalledWith("/api/projects/1/analysis-diff.zip?baseRunId=55&compareRunId=101", { credentials: "include" });
    expect(mocks.toast.error).toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalledWith(analysisResultCopy.toasts.diffDownloadSucceeded);
  });

  it("passes Flow filters to the query and returns to current source without a historical runId", async () => {
    const { result } = renderHook(() => useAnalysisResultModel(1));

    act(() => {
      result.current.setActiveTab("flow");
      result.current.inspectRun(55);
      result.current.setFlowTraceStatus("partial");
      result.current.setFlowTraceOperation("write");
      result.current.setFlowTraceConfidence("low");
    });

    await waitFor(() => {
      expect(mocks.flowTraceCalls.at(-1)).toMatchObject({
        projectId: 1,
        runId: 55,
        status: "partial",
        operation: "write",
        confidence: "low",
      });
    });

    act(() => result.current.returnToCurrentSource());

    await waitFor(() => {
      expect(mocks.flowTraceCalls.at(-1)).toMatchObject({ projectId: 1, page: 1 });
      expect(mocks.flowTraceCalls.at(-1)).not.toHaveProperty("runId");
    });
  });
});
