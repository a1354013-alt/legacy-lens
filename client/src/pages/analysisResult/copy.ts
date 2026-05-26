export const analysisResultCopy = {
  actions: {
    refresh: "重新整理",
    downloadReportZip: "下載報告 ZIP",
  },
  summary: {
    title: "摘要",
    description: "顯示目前快照指標與專案狀態。",
    fieldTableTitle: "欄位 / 資料表摘要",
    fieldTableDescription: "各資料表的讀寫熱點與參考次數。",
    noFieldTableSummary: "目前尚無欄位 / 資料表摘要。",
    fieldsBadge: (count: number) => `${count} 個欄位`,
    fieldStats: (readCount: number, writeCount: number, referenceCount: number) =>
      `讀取 ${readCount} / 寫入 ${writeCount} / 參考 ${referenceCount}`,
  },
  risk: {
    empty: "目前篩選條件下沒有風險項目。",
    unknownSource: "未知來源",
    noDescription: "目前沒有風險說明。",
    recommendation: (text: string) => `建議：${text}`,
  },
  pagination: {
    summary: (total: number, page: number, pageCount: number) => `共 ${total} 筆，第 ${page} / ${Math.max(pageCount, 1)} 頁`,
    previous: "上一頁",
    next: "下一頁",
  },
  toasts: {
    analysisQueued: "分析工作已排入佇列。",
    analysisQueueFailed: "無法啟動分析工作。",
    reportDownloadSucceeded: "報告 ZIP 已開始下載。",
    reportDownloadFailed: "無法下載報告 ZIP。",
  },
  fallbacks: {
    emptyDocument: "目前沒有可預覽的文件內容。",
  },
  capabilityNote: {
    title: "分析限制提醒",
    description:
      "Legacy Lens 提供輔助式靜態影響分析，可協助程式碼審查，但不是 compiler-grade 保證。動態 SQL、Go interface dispatch / reflection、以及 Delphi 複雜繼承或 DFM 不一致情境仍需人工複核。",
  },
} as const;
