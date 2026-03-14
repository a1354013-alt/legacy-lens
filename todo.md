# Legacy Lens - Project TODO

## 🔴 緊急修復（Critical Fixes）

### Phase 1: 修復檔案與重寫 Analyzer
- [x] 修復 README.md 的轉義問題（\n、\t 字面字元）
- [x] 刪除損壞的 Go 檔案（analyzer.go、document_generator.go、risk_detector.go）
- [x] 用 TypeScript 重寫 analyzer 模組
  - [x] parser.ts - Go/SQL 程式碼解析
  - [x] riskDetector.ts - 風險檢測引擎
  - [x] documentGenerator.ts - Markdown 文件生成
  - [x] analyzer.ts - 分析協調器
- [x] 驗證 TypeScript 編譯無誤

### Phase 2: 實作完整的分析流程
- [x] 實作 `projects.create` mutation
- [x] 實作 `analysis.trigger` mutation
  - [x] 觸發分析流程
  - [x] 執行 TypeScript analyzer
  - [x] 寫入 symbols table
  - [x] 寫入 risks table
  - [x] 寫入 analysisResults table
  - [x] 更新 project status
- [x] 實作錯誤處理與回滾

### Phase 3: 實作文件生成與下載
- [x] 實作 `analysis.downloadReport` endpoint
  - [x] 生成 FLOW.md
  - [x] 生成 DATA_DEPENDENCY.md
  - [x] 生成 RISKS.md
  - [x] 生成 RULES.yaml
- [x] 實作文件下載

### Phase 4: 接線前端 UI
- [x] ImportProject.tsx - 實作 handleSubmit
  - [x] 連接到 projects.create API
  - [x] 檔案上傳邏輯
  - [x] 進度提示
  - [x] 錯誤處理
- [x] AnalysisResult.tsx - 實作下載按鈕
  - [x] 連接到 analysis.downloadReport API
  - [x] 檔案下載邏輯

### Phase 5: 最終驗證
- [x] 修復所有編譯錯誤
- [ ] 端到端測試（上傳 → 分析 → 下載）
- [ ] 修復所有運行時錯誤
- [ ] 驗證資料庫操作
- [ ] 驗證文件生成質量

---

## ✅ 已完成的工作

### Phase 1: 專案初始化與資料庫結構設計
- [x] 設計資料庫 schema（projects, files, symbols, dependencies, risks, rules）
- [x] 建立 Drizzle ORM 表定義
- [x] 配置 Node/TS 後端項目結構
- [x] 建立基礎 API 路由框架

### Phase 2: 核心解析引擎（Go/SQL Parser）
- [x] 設計 Go 程式碼 parser 邏輯（抓取 function/method）
- [x] 設計 SQL 程式碼 parser 邏輯（抓取 table/field 引用）
- [x] 設計 Call Graph 分析（函數呼叫關係）
- [x] 設計 Data Dependency Graph（欄位讀寫關係）
- [x] 設計 symbol index 建立（檔案位置追蹤）

### Phase 3: 文件生成器與風險檢測引擎
- [x] 設計 Markdown 文件生成器（FLOW.md）
- [x] 設計欄位依賴文件生成（DATA_DEPENDENCY.md）
- [x] 設計風險檢測規則引擎
- [x] 設計 RISKS.md 生成
- [x] 設計出處追蹤系統（檔案名稱與行號）

### Phase 4: Gin API 端點與專案管理邏輯
- [x] 設計專案匯入 API
- [x] 設計語言選擇 API
- [x] 設計分析觸發 API
- [x] 設計文件下載 API
- [x] 設計專案列表 API
- [x] 設計分析結果查詢 API

### Phase 5: 優雅的前端界面
- [x] 建立 React + TypeScript 前端架構
- [x] 設計系統與色彩主題
- [x] 專案管理頁面
- [x] 專案匯入流程（上傳/Git clone）
- [x] 分析結果展示頁面
- [x] 風險清單展示


## 🔵 ZIP 檔案上傳與解析（New Feature）

### Phase 1: 安裝依賴與建立 ZIP 處理模組
- [x] 安裝 `jszip` 和 `unzipper` 依賴
- [x] 建立 `server/utils/zipHandler.ts` - ZIP 解析工具
- [x] 建立 `server/utils/fileExtractor.ts` - 檔案提取工具

### Phase 2: 實作後端 ZIP 解析與檔案保存
- [x] 實作 `projects.uploadFiles` mutation
  - [x] 接收 Base64 編碼的 ZIP 內容
  - [x] 解析 ZIP 檔案
  - [x] 提取程式碼檔案（.go, .sql, .pas 等）
  - [x] 過濾掉非程式碼檔案
  - [x] 保存檔案到 `files` table
- [x] 實作檔案類別検測
- [x] 實作檔案大小限制検查

### Phase 3: 實作前端 ZIP 上傳與進度追蹤
- [x] 使用前端 jszip 解析檔案
- [x] 實作進度条顯示
- [x] 實作上傳進度回調
- [x] 實作檔案預覽功能

### Phase 4: 整合自動分析觸發流程
- [x] 上傳完成後自動觸發 `analysis.trigger`
- [x] 實作分析進度實時更新
- [x] 實作分析完成後自動跳轉到結果頁面
- [x] 實作錯誤恢複機制

### Phase 5: 完整測試與最終優化
- [ ] 測試各種 ZIP 檔案格式
- [ ] 測試大檔案上傳
- [ ] 測試網路中斷恢複
- [ ] 性能優化
- [ ] UI/UX 優化


## 🔵 Phase 6: Git Clone 功能

- [x] 安裝 `simple-git` 依賴
- [x] 實作 `server/utils/gitHandler.ts` - Git 克隆工具
- [x] 實作 `projects.cloneGit` mutation
  - [x] 驗證 Git URL
  - [x] 克隆倉庫到臨時目錄
  - [x] 提取程式碼檔案
  - [x] 保存到資料庫
- [x] 更新 ImportProject.tsx 的 Git 上傳流程
- [x] 實作進度追蹤與錯誤處理

## 🔵 Phase 7: 欄位依賴圖視覺化

- [x] 安裝 `d3` 或 `mermaid` 依賴
- [x] 建立 `client/src/components/DependencyGraph.tsx` - 依賴圖組件
- [x] 實作圖形佈局算法
- [x] 實作互動功能（縮放、拖拽、點擊）
- [x] 在 AnalysisResult 頁面集成依賴圖
- [x] 實作圖例與說明
- [x] 性能優化（大型圖形）

## 🔵 Phase 8: 差異對齊検查功能

- [x] 建立 `server/analyzer/alignmentChecker.ts` - 對齊検查引擎
- [x] 實作 Delphi 流程提取
- [x] 實作 Go API 流程提取
- [x] 實作流程對比邏輯
- [x] 建立 `client/src/pages/AlignmentCheck.tsx` - 對齊検查頁面
- [x] 實作對齊結果展示表格
- [x] 實作風險等級評估
- [x] 實作遷移建議生成

## 🔵 Phase 9: 改進分析引擎 - AST 解析

- [x] 安裝 `typescript` 和 `@babel/parser` 依賴
- [x] 建立 `server/analyzer/astParser.ts` 使用 AST
  - [x] 使用 TypeScript Compiler API 解析 Go/TS
  - [x] 使用 Babel Parser 解析 JavaScript
  - [x] 改進函數簺寶解析
  - [x] 改進類別推斷
  - [x] 改進依賴追蹤
- [x] 優化符號索引
- [x] 改進風險検測準確度
- [x] 性能測試與優化

## 🟢 Phase 10: 整合測試與最終優化

- [ ] 端到端測試（Git Clone → 分析 → 視覺化）
- [ ] 大型專案測試
- [ ] 性能基準測試
- [ ] UI/UX 優化
- [ ] 文件完善
- [ ] 部署準備


## 🔴 P0 - 致命缺陷修複

- [x] P0-1: ImportProject.tsx 的 projectId 穬寫問題 - 改用實際回傳的 id
  - [x] 修複 server/routers.ts 的 projects.create 回傳 projectId
  - [x] 修複 ImportProject.tsx 提取實際 projectId
  - [x] 修複所有使用 projectId 的位置
- [x] P0-2: Buffer.from() 在瀏覽器環境的問題 - 改用 FileReader.readAsDataURL()
- [x] Git 上傳入口 disable/隱藏 - 避免 demo 破功

## 🟡 P1 - 後續改進

- [ ] 改進 Analyzer 的入口點判斷（route detector）
  - [ ] 抓取 .GET( .POST( .PUT( .DELETE( 等 route 註冊
  - [ ] 把 handler 當 entryPoints，往下追 call graph
- [ ] 實現完整的 ZIP 報告下載功能
  - [ ] 使用 archiver 打包 FLOW.md / DATA_DEPENDENCY.md / RISKS.md / RULES.yaml
  - [ ] 實作下載進度回饋
- [ ] 改進 SQL/Go parser 準確度
  - [ ] 添加更多 SQL 語法支援
  - [ ] 改進 Go 函數簽名解析
