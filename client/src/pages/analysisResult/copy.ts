export const analysisResultCopy = {
  actions: {
    refresh: "重新整理",
    downloadReportZip: "下載報告 ZIP",
  },
  summary: {
    title: "摘要",
    description: "先看關鍵統計與最需要處理的重點，再決定要往下鑽哪個區塊。",
    fieldTableTitle: "資料表 / 欄位摘要",
    fieldTableDescription: "快速檢查各資料表欄位被讀取、寫入與參照的密度。",
    noFieldTableSummary: "目前沒有可顯示的資料表 / 欄位摘要。",
    fieldsBadge: (count: number) => `${count} 個欄位`,
    fieldStats: (readCount: number, writeCount: number, referenceCount: number) =>
      `讀取 ${readCount} / 寫入 ${writeCount} / 參照 ${referenceCount}`,
  },
  warning: {
    title: "警告摘要",
    detailButton: "查看明細",
    sampleFileLabel: "範例檔案",
    noDetails: "沒有可顯示的明細。",
  },
  risk: {
    empty: "目前沒有可顯示的風險。",
    unknownSource: "來源待確認",
    noDescription: "這筆風險沒有額外描述。",
    recommendation: (text: string) => `建議：${text}`,
    occurrence: (count: number) => `出現 ${count} 次`,
    affectedFiles: (count: number) => `影響 ${count} 個檔案`,
  },
  rule: {
    empty: "目前沒有可顯示的規則群組。",
    unknownSource: "來源待確認",
    recommendation: (text: string) => `建議：${text}`,
    occurrence: (count: number) => `出現 ${count} 次`,
    affectedFiles: (count: number) => `影響 ${count} 個檔案`,
  },
  dependency: {
    hiddenStandardLibrary: (count: number) => `已預設隱藏 ${count} 筆 Delphi 標準函式庫相依`,
    internalCount: (count: number) => `內部相依 ${count}`,
    standardLibraryCount: (count: number) => `標準函式庫 ${count}`,
  },
  pagination: {
    summary: (total: number, page: number, pageCount: number) => `共 ${total} 筆，第 ${page} / ${Math.max(pageCount, 1)} 頁`,
    previous: "上一頁",
    next: "下一頁",
  },
  toasts: {
    analysisQueued: "分析已排入佇列",
    analysisQueueFailed: "無法建立分析工作。",
    reportDownloadSucceeded: "報告 ZIP 下載完成",
    reportDownloadFailed: "無法下載報告 ZIP。",
  },
  fallbacks: {
    emptyDocument: "沒有可顯示的文件內容。",
  },
  capabilityNote: {
    title: "分析能力提醒",
    description:
      "Legacy Lens 以啟發式方式整理既有系統脈絡，適合用來快速定位風險與討論改動範圍，但不等同 compiler-grade 的語意分析。",
  },
} as const;
