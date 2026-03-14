# Legacy Lens：程式碼考古與規則文件生成器

**把看不懂的舊系統程式碼（Delphi/Go/SQL）變成「可接手的規格書＋風險清單」**

## 🎯 核心價值

Legacy Lens 是一個智能程式碼分析平台，專為 ERP 維護團隊、系統轉型項目和新人接手設計。它通過靜態分析和規則引擎，自動生成：

- **FLOW.md** - 清晰的流程說明（入口 → 步驟 → 例外）
- **DATA_DEPENDENCY.md** - 欄位依賴圖（讀/寫/計算關係）
- **RISKS.md** - 風險提示（魔法值、多處寫入、缺少條件等）
- **RULES.yaml** - 規則定義（驗證規則、格式限制）

每一個結論都附帶**出處**（檔案名稱 + 行號），確保可信度。

## 🚀 解決的痛點

| 痛點 | 解決方案 |
|------|---------|
| 沒有文件，規格靠人腦 | 自動生成結構化文件 |
| 變更一個欄位牽一堆流程 | 欄位依賴圖清晰展示影響範圍 |
| 新人接手學習曲線爆炸 | 完整的流程說明與風險提示 |
| 轉型時無法確認「行為一致」 | 差異對齊清單（V1 功能） |

## 📋 功能範圍

### MVP（第一版）

**1. 專案匯入**
- 支援資料夾上傳（ZIP）
- 支援 Git clone
- 選擇語言：Go、SQL、Delphi（目前實作 Go + SQL）

**2. 程式碼結構化索引**
- Function/Procedure 清單
- 呼叫關係（Call Graph）
- 資料表與欄位引用
- 前端 API endpoint
- 狀態機線索（State / Flag / Mark）

**3. 一鍵產生「接手文件」**
- FLOW.md：流程說明
- DATA_DEPENDENCY.md：欄位依賴
- RISKS.md：風險提示
- RULES.yaml：規則定義

### V1 功能（後續）

- 差異對齊分析（舊 Delphi vs 新 Go API）
- 一致性檢查清單
- 欄位依賴圖視覺化

## 🏗️ 架構

```
Legacy Lens
├── client/                    # React + TypeScript 前端
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Home.tsx              # 專案列表
│   │   │   ├── ImportProject.tsx     # 匯入流程
│   │   │   └── AnalysisResult.tsx    # 分析結果
│   │   └── components/               # UI 元件
│   └── ...
├── server/                    # Node.js + Express + tRPC 後端
│   ├── routers.ts             # tRPC API 端點
│   ├── db.ts                  # 資料庫查詢幫手
│   ├── analyzer/              # TypeScript 分析引擎
│   │   ├── parser.ts          # Go/SQL 程式碼解析
│   │   ├── riskDetector.ts    # 風險檢測引擎
│   │   ├── documentGenerator.ts # 文件生成
│   │   └── analyzer.ts        # 分析協調器
│   └── _core/                 # 框架層（OAuth、tRPC、LLM 等）
├── drizzle/                   # 資料庫 schema
│   └── schema.ts              # 表定義
└── ...
```

## 🗄️ 資料庫設計

**核心表格：**

| 表名 | 用途 |
|------|------|
| `projects` | 專案管理（名稱、語言、狀態、進度） |
| `files` | 原始檔案（路徑、內容、語言） |
| `symbols` | 符號索引（函數、方法、查詢、表） |
| `dependencies` | 呼叫關係（A 呼叫 B） |
| `fields` | 欄位定義（表、欄位名、類型） |
| `fieldDependencies` | 欄位依賴（讀/寫/計算） |
| `risks` | 風險項目（類型、嚴重程度、位置） |
| `rules` | 規則定義（驗證規則、格式限制） |
| `analysisResults` | 分析結果（FLOW、DEPENDENCY、RISKS） |

## 🔧 安裝與運行

### 1. 安裝依賴

```bash
cd legacy-lens
pnpm install
pnpm db:push  # 初始化資料庫
```

### 2. 開發模式

```bash
pnpm dev
```

訪問 `http://localhost:3000`

### 3. 生產構建

```bash
pnpm build
pnpm start
```

## 📡 API 端點

### 專案管理

- `POST /api/trpc/projects.create` - 建立新專案
- `GET /api/trpc/projects.list` - 獲取專案列表
- `GET /api/trpc/projects.getById` - 獲取專案詳情
- `DELETE /api/trpc/projects.delete` - 刪除專案

### 分析功能

- `POST /api/trpc/analysis.trigger` - 觸發分析
- `GET /api/trpc/analysis.getResult` - 獲取分析結果
- `GET /api/trpc/analysis.getRisks` - 獲取風險清單
- `GET /api/trpc/analysis.getSymbols` - 獲取符號清單
- `GET /api/trpc/analysis.downloadReport` - 下載報告

## 🎨 前端設計

採用**優雅且完美**的設計風格：

- **色彩系統**：藍色主題 + 灰色中性色
- **排版**：清晰的層級結構，充足的空白
- **互動**：平滑的過渡動畫，即時的反饋
- **響應式**：完美支援桌面和平板

## 🧪 測試

```bash
# 執行單元測試
pnpm test

# 執行整合測試
pnpm test:integration
```

## 📚 核心技術棧

| 層級 | 技術 |
|------|------|
| 前端 | React 19 + TypeScript + Tailwind CSS 4 |
| 後端 | Node.js + Express + tRPC 11 |
| 資料庫 | MySQL + Drizzle ORM |
| 分析引擎 | TypeScript（正則表達式 + AST 分析） |
| 認證 | Manus OAuth |

## 🎓 亮點設計

### 1. 每一段結論都附「出處」

風險提示不是 AI 胡扯，而是有據可查：

```markdown
風險：ApplyDate 使用字串 yyyyMMdd，但某處轉換缺少補零
出處：api/doc.go:142、service/date.go:33
```

### 2. 欄位依賴用「讀/寫/計算」分類

清晰展示欄位的生命週期：

```markdown
EBUDG_NO：
  READ：查詢條件、Join
  WRITE：Insert/Update
  CALC：由 EBUDG_TYPE + EBUDG_YEAR 計算
```

### 3. Migration 對齊清單（V1）

直接從「工程師視角」升級到「技術負責人視角」：

| 舊流程步驟 | 新 API 是否涵蓋 | 缺漏規則 | 風險等級 |
|-----------|----------------|--------|--------|
| 驗證 ERP 編號 | ✅ | 無 | 低 |
| 計算預算額度 | ⚠️ | 缺少補零邏輯 | 高 |
| 寫入審核日期 | ✅ | 無 | 低 |

## 🚦 開發進度

- [x] 資料庫 schema 設計
- [x] 前端 UI 框架
- [x] API 路由設計
- [ ] TypeScript 分析引擎實作
- [ ] 匯入 → 分析 → 保存流程
- [ ] 文件生成與下載
- [ ] 前端 UI 接線
- [ ] 端到端測試

## 🤝 貢獻指南

1. Fork 專案
2. 建立特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 開啟 Pull Request

## 📄 授權

MIT License - 詳見 LICENSE 檔案

## 📞 反饋

有任何建議或問題？歡迎提交 Issue 或 Discussion！
