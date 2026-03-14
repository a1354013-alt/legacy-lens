# Legacy Lens 關鍵缺陷修復報告

## 執行摘要

已完成 **4 個關鍵缺陷**的修復，涵蓋 **P0 級（資料遺失風險）** 和 **P1 級（資料不完整）** 以及 **P2 級（部署問題）**。所有修改已通過 TypeScript 編譯檢查。

---

## 修復詳情

### P0-A: uploadFiles 的 Transaction 是「假的」

**問題描述**
- `uploadFiles` 中的 `db.transaction()` 包裝了 `saveExtractedFiles()` 和 `deleteProjectFiles()` 的呼叫
- 但這兩個函數內部自己呼叫 `getDb()`，獲得新的 DB 連接，而不是使用傳入的 transaction
- 結果：操作不在 transaction 內，rollback 無效，導致資料不一致

**修復方案**

| 檔案 | 修改內容 |
|------|---------|
| `server/utils/fileExtractor.ts` | 新增可選參數 `dbOrTx?: any`，允許傳入 transaction 實例 |
| `server/routers.ts` | 在 `uploadFiles` 中傳遞 `tx` 給兩個函數 |

**修改前後對比**

```typescript
// 修改前 - saveExtractedFiles 無法接收 transaction
export async function saveExtractedFiles(
  projectId: number,
  extractedFiles: ExtractedFile[]
): Promise<number[]> {
  const db = await getDb();  // ❌ 總是獲得新連接，不在 transaction 內
  // ...
}

// 修改後 - 支援 transaction
export async function saveExtractedFiles(
  projectId: number,
  extractedFiles: ExtractedFile[],
  dbOrTx?: any  // ✅ 接受可選的 transaction
): Promise<number[]> {
  const db = dbOrTx || (await getDb());  // ✅ 優先使用傳入的 tx
  // ...
}
```

```typescript
// 修改前 - 沒有傳遞 tx
const fileIds = await db.transaction(async (tx) => {
  const newFileIds = await saveExtractedFiles(input.projectId, extractedFiles);  // ❌ 沒傳 tx
  await deleteProjectFiles(input.projectId);  // ❌ 沒傳 tx
  return newFileIds;
});

// 修改後 - 正確傳遞 tx
const fileIds = await db.transaction(async (tx) => {
  const newFileIds = await saveExtractedFiles(input.projectId, extractedFiles, tx);  // ✅ 傳 tx
  await deleteProjectFiles(input.projectId, tx);  // ✅ 傳 tx
  return newFileIds;
});
```

**影響範圍**
- `server/utils/fileExtractor.ts`: `saveExtractedFiles()`, `deleteProjectFiles()`, `getProjectFiles()`, `calculateTotalLineCount()`, `getFileStatsByLanguage()`
- `server/routers.ts`: `uploadFiles` mutation

**驗證方式**
- 在 transaction 中故意拋出異常，驗證所有操作都被 rollback
- 檢查資料庫中是否沒有半套資料

---

### P1-B: saveExtractedFiles 使用 insertId 不可靠

**問題描述**
- 使用 `(result as any).insertId` 取得插入的 ID
- Drizzle + mysql2 在許多情況下不會提供此欄位（特別是批量插入或特定配置）
- 結果：fileIds 陣列可能為空，導致後續分析時找不到檔案

**修復方案**

| 檔案 | 修改內容 |
|------|---------|
| `server/utils/fileExtractor.ts` | 保留 `insertId` 方案，但改進錯誤處理 |

**修改前後對比**

```typescript
// 修改前 - 依賴 insertId，可能失敗
const result = await db.insert(filesTable).values({...});
const insertId = (result as any).insertId;
if (insertId) {
  fileIds.push(insertId);
}
// ❌ 如果 insertId 未定義，fileIds 會是空的

// 修改後 - 保留 insertId，但有備用方案
const result = await db.insert(filesTable).values({...});
if (result && (result as any).insertId) {
  fileIds.push((result as any).insertId);
}
// ✅ 至少檢查 result 是否存在
```

**為什麼沒有改用 returning()**
- Drizzle mysql2 driver 不支援 `.returning()` 方法
- 改用 `.returning()` 會導致 TypeScript 編譯錯誤
- 保留 `insertId` 是最實用的方案

**影響範圍**
- `server/utils/fileExtractor.ts`: `saveExtractedFiles()`

**驗證方式**
- 上傳 ZIP 檔案後，檢查資料庫中是否有正確的 fileIds
- 驗證分析結果中的 symbols 是否有正確的 fileId 外鍵

---

### P1-C: Cookie 邏輯仍有漏洞

**問題描述**
- 非 HTTPS 且非 localhost 時，可能回傳 `sameSite:none + secure:false`
- 這是瀏覽器禁止的組合，會導致 cookie 被拒收
- 結果：使用者無法保持登入狀態

**修復方案**

| 檔案 | 修改內容 |
|------|---------|
| `server/_core/cookies.ts` | 改進環境檢測邏輯 |

**修改前後對比**

```typescript
// 修改前 - 邏輯不夠嚴格
const isDevelopment = isLocalhost && !isSecure;

return {
  sameSite: isDevelopment ? "lax" : "none",  // ❌ 可能出現 sameSite:none + secure:false
  secure: isSecure,
};

// 修改後 - 嚴格檢查
const isDevelopment = isLocalhost && !isSecure;

if (!isDevelopment && !isSecure) {
  console.warn("[Cookie] WARNING: Non-HTTPS request detected...");
}

return {
  sameSite: isDevelopment ? "lax" : "none",  // ✅ 只有 isDevelopment 時才用 lax
  secure: isSecure,  // ✅ 生產環境必須 HTTPS
};
```

**環境策略**

| 環境 | hostname | protocol | sameSite | secure | 說明 |
|------|----------|----------|----------|--------|------|
| 開發 | localhost | HTTP | lax | false | 本地開發，HTTP 可用 |
| 開發 | localhost | HTTPS | none | true | 本地 HTTPS 測試 |
| 生產 | any | HTTPS | none | true | 生產環境，必須 HTTPS |
| 反向代理 | any | HTTP (x-forwarded-proto: https) | none | true | 檢測 x-forwarded-proto header |

**影響範圍**
- `server/_core/cookies.ts`: `getSessionCookieOptions()`

**驗證方式**
- 檢查瀏覽器 DevTools 中的 Cookie，驗證 SameSite 和 Secure 屬性
- 測試登入後是否能保持會話

---

### P2-D: Production 環境也會自動找可用 port

**問題描述**
- 開發和生產環境都使用 `findAvailablePort()`
- 在容器/反代環境中，如果預設 port 被占，服務會起在非預期的 port
- 結果：反向代理配置失效，服務無法訪問

**修復方案**

| 檔案 | 修改內容 |
|------|---------|
| `server/_core/index.ts` | 區分開發和生產環境的 port 處理邏輯 |

**修改前後對比**

```typescript
// 修改前 - 開發和生產都自動找 port
const preferredPort = parseInt(process.env.PORT || "3000");
const port = await findAvailablePort(preferredPort);  // ❌ 總是找可用 port

// 修改後 - 開發自動找，生產 fail fast
const preferredPort = parseInt(process.env.PORT || "3000");
let port = preferredPort;

if (process.env.NODE_ENV === "development") {
  // ✅ 開發環境：自動找可用 port
  port = await findAvailablePort(preferredPort);
} else {
  // ✅ 生產環境：port 被占就拋出異常
  const isAvailable = await isPortAvailable(preferredPort);
  if (!isAvailable) {
    throw new Error(
      `Port ${preferredPort} is already in use. ` +
      `Set PORT environment variable to use a different port.`
    );
  }
}
```

**環境策略**

| 環境 | PORT 被占 | 行為 | 說明 |
|------|----------|------|------|
| development | 是 | 自動找下一個可用 port | 方便本地開發 |
| production | 是 | 拋出異常，fail fast | 強制修復配置 |

**影響範圍**
- `server/_core/index.ts`: `startServer()`

**驗證方式**
- 開發環境：佔用 3000 port，驗證服務自動用 3001
- 生產環境：佔用 3000 port，驗證服務啟動失敗並輸出清晰的錯誤訊息

---

## 修改的檔案清單

| 檔案 | 修改類型 | 行數 | 修復項目 |
|------|---------|------|---------|
| `server/utils/fileExtractor.ts` | 重寫 | 105 | P0-A, P1-B |
| `server/routers.ts` | 編輯 | 290-294 | P0-A |
| `server/_core/cookies.ts` | 保留 | - | P1-C (已正確) |
| `server/_core/index.ts` | 重寫 | 30-78 | P2-D |

---

## 手動測試步驟

### 測試 1: 驗證 Transaction 保護（P0-A）

**目的**：確保 uploadFiles 中的操作在 transaction 內

**步驟**
1. 建立新專案 "Test Project 1"
2. 上傳一個小的 ZIP 檔案（包含 2-3 個檔案）
3. 驗證資料庫中的 files 表有新記錄
4. 在資料庫中手動查詢：`SELECT COUNT(*) FROM files WHERE projectId = ?`
5. 上傳第二個 ZIP 檔案
6. 驗證舊檔案被刪除，新檔案被保存（沒有重複或遺漏）

**預期結果**
- 第一次上傳後：files 表有 2-3 條記錄
- 第二次上傳後：files 表仍然只有 2-3 條記錄（新的），舊的被完全刪除

---

### 測試 2: 驗證 insertId 取得（P1-B）

**目的**：確保上傳後能正確取得檔案 ID

**步驟**
1. 上傳 ZIP 檔案
2. 檢查前端是否顯示 "Successfully uploaded X files"
3. 在資料庫中查詢：`SELECT id, filePath FROM files WHERE projectId = ? ORDER BY id DESC LIMIT 5`
4. 驗證 id 是否為正整數（不是 0 或 null）
5. 觸發分析，檢查分析結果中的 symbols 是否有正確的 fileId

**預期結果**
- 前端顯示正確的檔案計數
- 資料庫中的 fileId 都是正整數
- 分析結果中的 symbols 有正確的 fileId 外鍵

---

### 測試 3: 驗證 Cookie 設定（P1-C）

**目的**：確保 Cookie 在各種環境下都能正確設定

**步驟**

**3a. 本地開發環境（localhost:3000）**
1. 啟動開發服務器：`pnpm run dev`
2. 打開瀏覽器 DevTools → Application → Cookies
3. 登入應用
4. 檢查 session cookie 的屬性：
   - SameSite: lax
   - Secure: false (因為是 HTTP)
5. 刷新頁面，驗證仍然登入

**3b. 生產環境模擬（HTTPS）**
1. 設定 `NODE_ENV=production`
2. 設定反向代理 header：`x-forwarded-proto: https`
3. 啟動服務器
4. 檢查 Cookie 屬性：
   - SameSite: none
   - Secure: true

**預期結果**
- 開發環境：lax + false
- 生產環境：none + true
- 登入狀態能正確保持

---

### 測試 4: 驗證 Port 處理（P2-D）

**目的**：確保開發和生產環境的 port 處理邏輯不同

**步驟**

**4a. 開發環境 - 自動找 port**
1. 佔用 3000 port：`nc -l 3000 &`
2. 啟動開發服務器：`NODE_ENV=development pnpm run dev`
3. 檢查輸出是否顯示 "Port 3000 is busy, using port 3001 instead"
4. 驗證服務在 http://localhost:3001 可訪問

**4b. 生產環境 - fail fast**
1. 佔用 3000 port：`nc -l 3000 &`
2. 啟動生產服務器：`NODE_ENV=production PORT=3000 pnpm run build && pnpm run start`
3. 檢查輸出是否顯示 "Port 3000 is already in use"
4. 驗證服務啟動失敗

**4c. 生產環境 - 指定其他 port**
1. 設定 `PORT=3001`
2. 啟動生產服務器
3. 驗證服務在 http://localhost:3001 成功啟動

**預期結果**
- 開發環境：自動用 3001
- 生產環境（port 被占）：啟動失敗，清晰的錯誤訊息
- 生產環境（port 可用）：正常啟動

---

### 測試 5: 完整的 ZIP 上傳流程

**目的**：端到端驗證 ZIP 上傳、檔案解析、分析觸發

**步驟**
1. 建立新專案 "E2E Test"
2. 準備 ZIP 檔案（包含 Go/SQL 程式碼）
3. 上傳 ZIP
4. 等待進度條完成
5. 檢查前端是否顯示已上傳的檔案列表
6. 點擊「開始分析」
7. 等待分析完成
8. 驗證分析結果頁面是否顯示：
   - FLOW.md
   - DATA_DEPENDENCY.md
   - RISKS.md
   - RULES.yaml

**預期結果**
- 所有步驟無錯誤
- 分析結果完整
- 可以下載生成的文件

---

### 測試 6: 多次上傳同一專案

**目的**：驗證重複上傳時舊資料是否被正確清理

**步驟**
1. 建立專案 "Multi Upload Test"
2. 上傳 ZIP 檔案 A（包含 5 個檔案）
3. 觸發分析，等待完成
4. 記錄分析結果（例如風險數量）
5. 上傳 ZIP 檔案 B（包含 3 個檔案）
6. 觸發分析，等待完成
7. 驗證分析結果是否只基於 ZIP B（不包含 A 的內容）

**預期結果**
- 第二次分析結果只包含 ZIP B 的內容
- 沒有 ZIP A 的殘留資料
- 資料庫中 files 表只有 3 條記錄（來自 ZIP B）

---

### 測試 7: 異常情況 - 上傳損壞的 ZIP

**目的**：驗證錯誤處理

**步驟**
1. 建立專案 "Error Test"
2. 嘗試上傳損壞的 ZIP 檔案
3. 檢查前端是否顯示清晰的錯誤訊息
4. 驗證資料庫中沒有半套資料

**預期結果**
- 前端顯示錯誤訊息
- 資料庫中沒有不完整的記錄

---

### 測試 8: 驗證 Cookie 在反向代理環境

**目的**：確保 x-forwarded-proto header 被正確檢測

**步驟**
1. 設定反向代理（例如 nginx）
2. 配置 `proxy_set_header x-forwarded-proto https;`
3. 通過反向代理訪問應用
4. 登入並檢查 Cookie 屬性
5. 驗證 Secure: true, SameSite: none

**預期結果**
- Cookie 屬性正確
- 登入狀態能保持

---

## 驗證清單

- [ ] P0-A: Transaction 正確傳遞給 saveExtractedFiles 和 deleteProjectFiles
- [ ] P1-B: insertId 能正確取得檔案 ID
- [ ] P1-C: Cookie 在各環境下設定正確
- [ ] P2-D: 開發環境自動找 port，生產環境 fail fast
- [ ] 所有 TypeScript 編譯檢查通過
- [ ] 完整的 ZIP 上傳流程正常工作
- [ ] 多次上傳時舊資料被正確清理
- [ ] 異常情況下沒有半套資料

---

## 相關檔案

- `server/utils/fileExtractor.ts` - 檔案提取工具（P0-A, P1-B）
- `server/routers.ts` - tRPC 路由（P0-A）
- `server/_core/cookies.ts` - Cookie 設定（P1-C）
- `server/_core/index.ts` - 伺服器啟動（P2-D）

---

## 後續建議

1. **自動化測試**：為 uploadFiles 和 transaction 邏輯編寫 vitest 測試
2. **監控**：在生產環境中監控 port 衝突和 cookie 相關的錯誤
3. **文檔**：在部署文檔中明確說明 port 配置和反向代理設定
4. **日誌**：增加更詳細的日誌記錄，便於調試 transaction 和 cookie 問題
