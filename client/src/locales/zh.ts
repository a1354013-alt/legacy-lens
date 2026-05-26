const zh = {
  importProject: {
    pageTitle: "匯入專案",
    backHome: "返回首頁",
    pageDescription: "上傳 ZIP 壓縮檔或輸入 Git 倉庫網址，讓 Legacy Lens 建立可分析的專案。",
    phaseLabel: {
      idle: "準備中",
      creating: "建立專案",
      "waiting-import": "等待匯入",
      "waiting-analysis": "等待分析",
      redirecting: "前往分析頁",
    },
    phaseDescription: {
      idle: "填寫專案資訊並選擇匯入來源後即可開始。",
      creating: "正在建立專案並準備匯入工作。",
      "waiting-import": "匯入工作已排入佇列，系統會持續處理 ZIP 或 Git 來源。",
      "waiting-analysis": "匯入完成後，系統會自動建立分析工作。",
      redirecting: "分析完成，正在帶你前往結果頁面。",
    },
    status: {
      project: "專案狀態",
      jobType: "工作類型",
      jobStatus: "工作狀態",
      progress: "進度",
      loading: "讀取中",
      none: "尚無",
    },
    sourceCard: {
      title: "匯入來源",
      description: "可從 ZIP 壓縮檔匯入，或由 Git 倉庫複製原始碼。",
      uploadTitle: "ZIP 上傳",
      uploadDescription: "上傳專案原始碼 ZIP，系統會將支援的來源檔案匯入並排入分析。",
      gitTitle: "Git 倉庫",
      gitDescription: "提供 repository URL，系統會在安全檢查後自動 clone 並匯入。",
    },
    detailCard: {
      title: "專案資訊",
      name: "專案名稱",
      description: "描述",
      descriptionPlaceholder: "例如：ERP 付款流程重構前評估、月結批次風險盤點。",
      language: "主要語言",
      languageHint: "請選擇這次分析最關注的語言。Legacy Lens 目前支援 Go、SQL 與 Delphi 的輔助式分析。",
    },
    uploadCard: {
      title: "上傳 ZIP",
      description: "請選擇一個 ZIP 壓縮檔。系統會先檢查大小與安全性，再建立匯入工作。",
      pickFile: "選擇 ZIP 檔案",
      fileLimit: "ZIP 檔案大小上限：{size}",
    },
    gitCard: {
      title: "Git 倉庫",
      description: "輸入可存取的 Git 倉庫 URL。",
      urlLabel: "Repository URL",
    },
    actions: {
      cancel: "取消",
      submit: "建立並開始匯入",
    },
    alerts: {
      errorTitle: "匯入失敗",
      importQueued: "匯入工作已排入佇列。",
      analysisComplete: "分析完成，正在前往結果頁。",
      uploadFailed: "上傳失敗，請稍後再試。",
      importFailed: "匯入工作失敗。",
      analysisQueueFailed: "無法建立分析工作。",
      createFailed: "無法建立專案。",
    },
    errors: {
      projectNameRequired: "請輸入專案名稱。",
      fileRequired: "請選擇 ZIP 檔案。",
      gitUrlRequired: "請輸入 Git 倉庫網址。",
    },
  },
  uploadValidation: {
    zipTooLarge: "ZIP 檔案超過 Legacy Lens 前端允許的上限 {size}。請縮小壓縮檔後再試。",
  },
} as const;

export default zh;
