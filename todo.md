# Legacy Lens - Project TODO

## Phase 1: 專案初始化與資料庫結構設計
- [x] 設計資料庫 schema（projects, files, symbols, dependencies, risks, rules）
- [x] 建立 Drizzle ORM 表定義
- [x] 配置 Go 後端項目結構
- [x] 建立基礎 API 路由框架

## Phase 2: 核心解析引擎（Go/SQL Parser）
- [x] 實作 Go 程式碼 parser（抓取 function/method）
- [x] 實作 SQL 程式碼 parser（抓取 table/field 引用）
- [x] 建立 Call Graph 分析（函數呼叫關係）
- [x] 建立 Data Dependency Graph（欄位讀寫關係）
- [x] 實作 symbol index 建立（檔案位置追蹤）

## Phase 3: 文件生成器與風險檢測引擎
- [x] 實作 Markdown 文件生成器（FLOW.md）
- [x] 實作欄位依賴文件生成（DATA_DEPENDENCY.md）
- [x] 實作風險檢測規則引擎
  - [x] 魔法值檢測
  - [x] 多處寫入同欄位檢測
  - [x] SQL 缺少條件檢測
  - [x] 日期/金額格式轉換檢測
- [x] 實作 RISKS.md 生成
- [x] 出處追蹤系統（檔案名稱與行號）

## Phase 4: Gin API 端點與專案管理邏輯
- [x] 專案匯入 API（資料夾上傳、Git clone）
- [x] 語言選擇 API（Delphi/Go/SQL）
- [x] 分析觸發 API
- [x] 文件下載 API
- [x] 專案列表 API
- [x] 分析結果查詢 API

## Phase 5: 優雅的前端界面
- [x] 建立 React + TypeScript 前端架構
- [x] 設計系統與色彩主題
- [x] 專案管理頁面
- [x] 專案匯入流程（上傳/Git clone）
- [x] 分析結果展示頁面
- [ ] 依賴圖視覺化
- [x] 風險清單展示
- [ ] 文件預覽與下載

## Phase 6: 差異對齊與規則抽取功能（V1）
- [ ] 差異對齊分析（舊 Delphi vs 新 Go API）
- [ ] 一致性檢查清單生成
- [ ] 規則抽取引擎
- [ ] RULES.yaml 生成

## Phase 7: 整合測試與效能優化
- [ ] 單元測試（parser、generator、risk engine）
- [ ] 整合測試（API 端點）
- [ ] 效能優化（大型專案解析）
- [ ] 錯誤處理與邊界情況

## Phase 8: 文件與交付
- [x] 撰寫 README.md
- [ ] 撰寫使用說明文件
- [ ] 撰寫 API 文件
- [ ] 準備 demo 與展示材料
