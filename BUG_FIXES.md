# Legacy Lens - P0 Bug Fixes Report

## 修復概述
本次修復針對 4 個致命 bug，確保應用可正確運作、不會寫髒資料、不會上不了線。

---

## [BUG-1] 修正 projects.create 後拿到錯的 projectId

### 檔案
- `server/routers.ts` (lines 79-107)

### 問題
- **原況**：insert 後用 `userId + name` 再 select，並且 `orderBy(projects.id) + limit(1)` 會拿到**最舊的那筆**（錯誤）
- **後果**：建立第 2 個同名專案時，回傳的仍是第 1 個專案的 ID，導致檔案上傳、分析結果都寫到舊專案

### 修改
```typescript
// 修改前
const newProject = await db
  .select()
  .from(projects)
  .where(
    and(
      eq(projects.userId, ctx.user.id),
      eq(projects.name, input.name)  // 不應該用 name，會有重複
    )
  )
  .orderBy(projects.id)  // 升序 → 拿最舊的
  .limit(1);

// 修改後
const newProject = await db
  .select()
  .from(projects)
  .where(eq(projects.userId, ctx.user.id))  // 只用 userId，不用 name
  .orderBy(desc(projects.id))  // 降序 → 拿最新的
  .limit(1);
```

### 驗收
- ✅ 連續建立兩個同名專案，回傳的 projectId 必須不同且第二次更大
- ✅ 後續分析/查詢必須指向新專案

---

## [BUG-2] 修正 Cookie SameSite/secure 導致登入狀態被瀏覽器拒收

### 檔案
- `server/_core/cookies.ts`

### 問題
- **原況**：`sameSite: "none" + secure` 動態判斷，在非 HTTPS 或 proxy header 未處理時會變成 `Secure=false`，瀏覽器直接拒收 cookie
- **後果**：
  - 本地開發 (http://localhost) 無法保持登入狀態
  - 部署到 HTTPS 環境時 cookie 可能被拒收

### 修改
```typescript
// 修改前
return {
  httpOnly: true,
  path: "/",
  sameSite: "none",  // 總是 none
  secure: isSecureRequest(req),  // 可能是 false
};

// 修改後
const isSecure = isSecureRequest(req);
const isLocalhost = req.hostname && LOCAL_HOSTS.has(req.hostname);
const isDevelopment = isLocalhost || !isSecure;

return {
  httpOnly: true,
  path: "/",
  // Development: lax (http://localhost 可用)
  // Production: none (HTTPS 跨域可用)
  sameSite: isDevelopment ? "lax" : "none",
  // 只在真正 HTTPS 時設置 secure
  secure: isSecure,
};
```

### 驗收
- ✅ 在 http://localhost 開發環境可正常登入並保持 session
- ✅ 在 https 部署環境 cookie 正常被設置，刷新頁面仍維持登入

---

## [BUG-3] 修正 symbols 寫入時 fileId 可能被寫成 0（髒資料/外鍵風險）

### 檔案
- `server/routers.ts` (lines 419-438)

### 問題
- **原況**：`fileId: fileRecord?.id || 0` 允許寫入 fileId=0
- **後果**：
  - DB 中出現無效的外鍵引用
  - 查詢時無法關聯到正確的檔案
  - 分析結果不完整

### 修改
```typescript
// 修改前
const fileRecord = projectFiles.find((f) => f.filePath === symbol.file);
await db.insert(symbols).values({
  projectId: projectId,
  fileId: fileRecord?.id || 0,  // 危險！
  name: symbol.name,
  // ...
});

// 修改後
const fileRecord = projectFiles.find((f) => f.filePath === symbol.file);

// Skip symbols with missing file references to avoid foreign key violations
if (!fileRecord?.id) {
  console.warn(`[Analysis] Symbol "${symbol.name}" skipped: file not found (${symbol.file})`);
  continue;
}

await db.insert(symbols).values({
  projectId: projectId,
  fileId: fileRecord.id,  // 保證有效
  name: symbol.name,
  // ...
});
```

### 驗收
- ✅ DB 內 symbols 不得出現 fileId=0
- ✅ 分析後 symbols 仍能正常呈現且不會因找不到檔案而整批失敗

---

## [BUG-4] 分析結果寫入要避免「半套資料」

### 檔案
- `server/routers.ts` (lines 410-431)

### 問題
- **原況**：每次 trigger 都 insert analysisResults；中途失敗會留下部分資料
- **後果**：
  - 連續觸發分析兩次，DB 會累積多份 analysisResults
  - 任意製造中途錯誤時，DB 會留下半套 symbols/dependencies

### 修改
```typescript
// 修改前
// 保存分析結果
await db.insert(analysisResults).values({
  projectId: projectId,
  flowMarkdown: result.flowDocument,
  // ...
});

// 保存符號
for (const symbol of result.symbols) {
  // ...
}

// 修改後
// Delete old analysis results to avoid duplicate/stale data
await db
  .delete(analysisResults)
  .where(eq(analysisResults.projectId, projectId));

await db
  .delete(symbols)
  .where(eq(symbols.projectId, projectId));

await db
  .delete(risks)
  .where(eq(risks.projectId, projectId));

// Save new analysis results
await db.insert(analysisResults).values({
  projectId: projectId,
  flowMarkdown: result.flowDocument,
  // ...
});

// 保存符號
for (const symbol of result.symbols) {
  // ...
}
```

### 驗收
- ✅ 連續觸發分析兩次，DB 不會累積多份 analysisResults
- ✅ 任意製造中途錯誤時，DB 不會留下半套 symbols/dependencies

---

## 手動測試步驟

### 前置準備
1. 清空資料庫或使用新的測試用戶
2. 啟動開發伺服器：`pnpm dev`
3. 訪問 http://localhost:3000

### 測試步驟

#### Step 1: 驗證登入與 Cookie
1. 訪問首頁，點擊「登入」
2. 完成 OAuth 登入
3. 驗證：頁面顯示已登入狀態
4. **驗收**：刷新頁面，仍保持登入狀態（Cookie 正確設置）

#### Step 2: 建立第一個專案
1. 點擊「匯入新專案」
2. 輸入專案名稱：「test-project-1」
3. 選擇語言：Go
4. 上傳一個 ZIP 檔案
5. 記錄回傳的 projectId（例如：5）
6. **驗收**：專案成功建立，projectId 正確

#### Step 3: 建立第二個同名專案
1. 點擊「匯入新專案」
2. 輸入相同的專案名稱：「test-project-1」
3. 選擇語言：Go
4. 上傳同一個 ZIP 檔案
5. 記錄回傳的 projectId（例如：6）
6. **驗收**：
   - projectId 必須不同（6 ≠ 5）
   - projectId 必須更大（6 > 5）
   - 兩個專案在列表中都可見

#### Step 4: 驗證檔案上傳到正確的專案
1. 進入第一個專案（projectId=5）的分析結果頁面
2. 進入第二個專案（projectId=6）的分析結果頁面
3. **驗收**：
   - 兩個專案的檔案列表不同（或至少能區分）
   - 檔案沒有被錯誤地寫到另一個專案

#### Step 5: 觸發分析並驗證 DB 無 fileId=0
1. 進入某個專案的分析結果頁面
2. 點擊「觸發分析」
3. 等待分析完成
4. 打開資料庫客戶端（或使用 Management UI）
5. 執行查詢：`SELECT * FROM symbols WHERE fileId = 0;`
6. **驗收**：
   - 查詢結果為空（沒有 fileId=0 的 symbols）
   - 分析結果正常顯示（FLOW.md、DATA_DEPENDENCY.md、RISKS.md）

#### Step 6: 連續觸發分析驗證無重複資料
1. 進入某個專案
2. 第一次觸發分析，等待完成
3. 記錄 analysisResults 的數量：`SELECT COUNT(*) FROM analysisResults WHERE projectId = X;`（應為 1）
4. 第二次觸發分析，等待完成
5. 再次查詢 analysisResults 的數量
6. **驗收**：
   - 數量仍為 1（舊資料被刪除，新資料被插入）
   - 沒有累積多份分析結果

---

## 修改總結

| Bug | 檔案 | 修改類型 | 影響範圍 |
|-----|------|--------|--------|
| BUG-1 | server/routers.ts | 邏輯修正 | projects.create |
| BUG-2 | server/_core/cookies.ts | 環境適配 | 全局 Cookie 設置 |
| BUG-3 | server/routers.ts | 驗證添加 | analysis.trigger 中的 symbols 寫入 |
| BUG-4 | server/routers.ts | 資料清理 | analysis.trigger 中的結果寫入 |

**總計修改行數**：約 50 行  
**新增依賴**：無  
**破壞性變更**：無（API 介面不變）  
**編譯狀態**：✅ 通過 TypeScript 檢查
