const zh = {
  importProject: {
    pageTitle: "匯入專案",
    backHome: "返回首頁",
    pageDescription: "上傳 ZIP 或提供 Git 儲存庫網址，Legacy Lens 會在背景建立匯入與分析工作。",
    phaseLabel: {
      idle: "等待開始",
      creating: "建立專案中",
      "waiting-import": "等待匯入完成",
      "waiting-analysis": "等待分析完成",
      redirecting: "正在前往結果頁",
    },
    phaseDescription: {
      idle: "填寫專案資訊後即可開始匯入。",
      creating: "正在建立新的專案紀錄。",
      "waiting-import": "匯入工作已送出，檔案會透過串流請求送到伺服器並在背景處理。",
      "waiting-analysis": "匯入完成後，系統會接著執行分析工作。",
      redirecting: "分析完成，正在開啟結果頁。",
    },
    status: {
      project: "專案狀態",
      jobType: "最新工作",
      jobStatus: "工作狀態",
      progress: "進度",
      loading: "讀取中",
      none: "尚未開始",
    },
    sourceCard: {
      title: "匯入來源",
      description: "選擇要從 ZIP 壓縮檔匯入，或直接從 Git 儲存庫抓取原始碼。",
      uploadTitle: "ZIP 上傳",
      uploadDescription: "直接上傳 ZIP 檔案，適合本機整理好的原始碼快照。",
      gitTitle: "Git 儲存庫",
      gitDescription: "提供 repository URL，讓伺服器在背景 clone 後匯入。",
    },
    detailCard: {
      title: "專案資訊",
      name: "專案名稱",
      description: "描述",
      descriptionPlaceholder: "例如：ERP 移轉前盤點、風險盤查或相依分析。",
      language: "主要語言",
      languageHint: "主要語言會影響 UI 預設焦點，但分析仍會掃描支援的 Go、SQL 與 Delphi 檔案。",
    },
    uploadCard: {
      title: "上傳 ZIP",
      description: "請選擇一個包含原始碼的 ZIP 檔案。系統會在伺服器端解壓並驗證內容。",
      pickFile: "選擇 ZIP 檔案",
      fileLimit: "ZIP 檔案上限 {size}MB",
    },
    gitCard: {
      title: "Git 儲存庫",
      description: "輸入可供伺服器 clone 的 Git URL。",
      urlLabel: "Repository URL",
    },
    actions: {
      cancel: "取消",
      submit: "建立並開始匯入",
    },
    alerts: {
      errorTitle: "匯入失敗",
      importQueued: "匯入工作已送出。",
      analysisComplete: "分析完成，正在開啟結果頁。",
      uploadFailed: "上傳失敗",
      importFailed: "匯入工作失敗。",
      analysisQueueFailed: "分析工作送出失敗。",
      createFailed: "建立專案失敗。",
    },
    errors: {
      projectNameRequired: "請輸入專案名稱。",
      fileRequired: "請選擇 ZIP 檔案。",
      gitUrlRequired: "請輸入 Git 儲存庫網址。",
    },
  },
  uploadValidation: {
    zipTooLarge: "ZIP 檔案過大。Legacy Lens 目前只接受 {size} 以內的 ZIP 檔案，請縮小或移除大型檔案後再試一次。",
  },
} as const;

export default zh;
