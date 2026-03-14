# Legacy Lens - 全面 Bug 修復總結

## 修復優先級與內容

### P0 必修：會直接壞掉的問題

#### ✅ BUG-1: 建立專案後回傳 projectId
**檔案**: `server/routers.ts`
**現況**: projects.create 已正確回傳 projectId（第 106 行）
**狀態**: ✅ 已驗證正確

---

#### ✅ BUG-2: Cookie SameSite/Secure 設定
**檔案**: `server/_core/cookies.ts`
**修改內容**:
- 改進 `isSecureRequest()` 邏輯，正確檢測 `x-forwarded-proto` header
- 開發環境 (localhost + HTTP): `sameSite="lax"`, `secure=false`
- 生產環境 (HTTPS): `sameSite="none"`, `secure=true`
- 添加 warning log 檢測反向代理 header 缺失

**修改前**:
```typescript
secure: isSecure && !isDevelopment,
```

**修改後**:
```typescript
secure: isSecure,
```

**原因**: 確保在 HTTPS 環境下 cookie 被正確接收，避免登入後刷新掉線

---

#### ✅ BUG-3: fileId 可能被寫成 0
**檔案**: `server/routers.ts` (analysis.trigger)
**現況**: 已添加 skip 邏輯，不允許 fileId=0
```typescript
if (!fileRecord?.id) {
  console.warn(`[Analysis] Symbol "${symbol.name}" skipped: file not found`);
  continue;
}
```
**狀態**: ✅ 已驗證正確

---

#### ✅ BUG-4: analysis.trigger 缺少 transaction
**檔案**: `server/routers.ts` (analysis.trigger)
**現況**: 已使用 `db.transaction()` 包裝所有 DB 操作
```typescript
await db.transaction(async (tx) => {
  // 所有 insert/update 操作
  // 失敗時自動 rollback
});
```
**狀態**: ✅ 已驗證正確

---

### P1 高優先：會寫出髒資料 / 會越跑越亂

#### ✅ BUG-5: ZIP 上傳缺少安全限制
**檔案**: `server/utils/zipHandler.ts`
**修改內容**:
- 添加 `MAX_FILES_IN_ZIP = 1000` 限制
- 添加 `MAX_TOTAL_EXTRACTED_SIZE = 500MB` 限制
- 添加 `MAX_SINGLE_FILE_SIZE = 50MB` 限制
- 添加 `MAX_COMPRESSION_RATIO = 100` 防 Zip bomb
- 在 `extractFilesFromZip()` 中添加檢查
- 在 `validateZipFile()` 中添加大小檢查

**修改前**:
```typescript
// 無安全檢查
for (const [filePath, file] of Object.entries(loadedZip.files)) {
  const content = await file.async("string");
  extractedFiles.push({ ... });
}
```

**修改後**:
```typescript
// 添加安全檢查
if (fileCount >= MAX_FILES_IN_ZIP) {
  throw new Error(`ZIP 檔案中的檔案數超過限制`);
}
if (fileSize > MAX_SINGLE_FILE_SIZE) {
  console.warn(`File exceeds size limit, skipping`);
  continue;
}
totalExtractedSize += fileSize;
if (totalExtractedSize > MAX_TOTAL_EXTRACTED_SIZE) {
  throw new Error(`解壓後的總大小超過限制`);
}
```

**原因**: 防止 Zip bomb 攻擊、記憶體爆炸、多人同時上傳時的資源耗盡

---

### P2 中優先：上線穩定性 / 效能與安全

#### ✅ BUG-6: 權限層缺少統一防呆
**檔案**: `server/routers.ts`, `server/_core/trpc.ts`
**修改內容**:
- 改用 `protectedProcedure` 替代 `publicProcedure`（針對敏感操作）
- 移除冗餘的 `if (!ctx.user)` 檢查（因為 protectedProcedure 已保證）

**修改的 procedures**:
- `projects.list` ✅
- `projects.getById` ✅
- `projects.create` ✅
- `projects.delete` ✅
- `projects.cloneGit` ✅
- `projects.uploadFiles` ✅
- `projects.updateStatus` ✅
- `analysis.trigger` ✅
- `analysis.getResult` ✅
- `analysis.getRisks` ✅
- `analysis.getSymbols` ✅
- `analysis.downloadReport` ✅

**修改前**:
```typescript
create: publicProcedure
  .mutation(async ({ ctx, input }) => {
    if (!ctx.user) throw new Error("Not authenticated");
    // ...
  })
```

**修改後**:
```typescript
create: protectedProcedure
  .mutation(async ({ ctx, input }) => {
    // ctx.user 已保證存在
    // ...
  })
```

**原因**: 
- 集中權限檢查，避免漏掉某個 endpoint
- 減少代碼重複
- 提升安全性

---

## 修復驗收清單

### 編譯檢查
- [x] TypeScript 編譯無錯誤
- [x] 所有 import 正確
- [x] 所有類型檢查通過

### 功能驗收

#### BUG-2 Cookie 驗收
```bash
# 開發環境測試
curl -i http://localhost:3000/api/trpc/auth.me
# 應看到: Set-Cookie: ... ; SameSite=Lax; Secure=false

# 生產環境測試（HTTPS）
curl -i https://example.com/api/trpc/auth.me
# 應看到: Set-Cookie: ... ; SameSite=None; Secure=true
```

#### BUG-5 ZIP 安全驗收
```bash
# 測試超大 ZIP（應被拒絕）
# 測試超多檔案 ZIP（應被拒絕）
# 測試正常 ZIP（應通過）
```

#### BUG-6 權限驗收
```bash
# 未登入時調用 protectedProcedure（應返回 UNAUTHORIZED）
# 已登入時調用 protectedProcedure（應正常執行）
```

---

## 手動測試步驟

### 1. 登入測試
```
1. 訪問 http://localhost:3000
2. 點擊登入按鈕
3. 完成 OAuth 登入
4. 刷新頁面 → 應保持登入狀態
5. 檢查 DevTools → Application → Cookies → 應看到 session cookie
```

### 2. 建立專案測試
```
1. 點擊「匯入新專案」
2. 輸入專案名稱 "Test Project 1"
3. 選擇語言 "Go"
4. 選擇來源類型 "ZIP"
5. 點擊「建立」
6. 檢查返回的 projectId（應 > 0）
7. 記錄 projectId（例如 123）
```

### 3. 重複建立同名專案測試
```
1. 再次建立專案名稱 "Test Project 1"
2. 檢查返回的 projectId（應 > 之前的 projectId）
3. 驗證兩個專案在列表中都存在
4. 驗證它們的 ID 不同
```

### 4. ZIP 上傳測試
```
1. 準備一個包含 Go 程式碼的 ZIP 檔案
2. 點擊「上傳 ZIP」
3. 選擇 ZIP 檔案
4. 觀察進度條
5. 上傳完成後應自動觸發分析
6. 檢查 DB → files 表 → 應有新檔案記錄
```

### 5. 分析觸發測試
```
1. 在分析結果頁面點擊「重新分析」
2. 觀察分析進度
3. 分析完成後應顯示結果
4. 檢查 DB → symbols 表 → 應無 fileId=0 的記錄
5. 檢查 DB → analysisResults 表 → 應只有最新的結果（無重複）
```

### 6. 資料庫驗收
```sql
-- 檢查 symbols 表中是否有 fileId=0
SELECT COUNT(*) FROM symbols WHERE fileId = 0;
-- 結果應為 0

-- 檢查 analysisResults 表是否有重複
SELECT projectId, COUNT(*) as cnt FROM analysisResults GROUP BY projectId HAVING cnt > 1;
-- 結果應為空

-- 檢查 files 表中的路徑是否一致
SELECT DISTINCT filePath FROM files WHERE projectId = 123;
-- 結果應為相對路徑，分隔符統一為 /
```

---

## 部署注意事項

### 環境變數
- 確保 `NODE_ENV=production` 時 `x-forwarded-proto` header 被正確設置
- 反向代理（Nginx/Apache）應正確轉發 `x-forwarded-proto` header

### 資料庫
- 執行 `pnpm db:push` 確保 schema 最新
- 檢查現有資料中是否有 `fileId=0` 的 symbols（手動清理）

### 監控
- 監控 `[Cookie] WARNING` 日誌（表示反向代理配置有問題）
- 監控 `[ZIP]` 日誌（表示上傳異常）
- 監控 `[Analysis]` 日誌（表示分析異常）

---

## 修復統計

| Bug | 檔案 | 行數 | 優先級 | 狀態 |
|-----|------|------|--------|------|
| BUG-1 | routers.ts | 106 | P0 | ✅ 驗證正確 |
| BUG-2 | cookies.ts | 52 | P0 | ✅ 已修復 |
| BUG-3 | routers.ts | 443-446 | P0 | ✅ 驗證正確 |
| BUG-4 | routers.ts | 380-450 | P0 | ✅ 驗證正確 |
| BUG-5 | zipHandler.ts | 全文 | P1 | ✅ 已修復 |
| BUG-6 | routers.ts | 全文 | P2 | ✅ 已修復 |

**總計**: 6 個 bug，全部修復完成 ✅
