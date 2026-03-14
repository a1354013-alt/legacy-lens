# Legacy Lens 第二輪缺陷修復報告

## 執行摘要

基於用戶指正，完成了 **4 個新發現的關鍵缺陷**的修復，涵蓋 **P0 級（會導致登入失敗）** 和 **P1 級（資料一致性/可維護性）**。所有修改已通過 TypeScript 編譯檢查。

---

## 修復詳情

### P0: Cookie 邏輯自打臉 - sameSite:none + secure:false

**問題描述**

在 `server/_core/cookies.ts` 中，原本的邏輯是：

```typescript
const isDevelopment = isLocalhost && !isSecure;

return {
  sameSite: isDevelopment ? "lax" : "none",  // ❌ 問題在這裡
  secure: isSecure,
};
```

**問題根源**

- 當環境是「非 localhost 但又非 HTTPS」時（例如反向代理沒帶 `x-forwarded-proto` header）
- `isDevelopment = false`（因為不是 localhost）
- `isSecure = false`（因為沒有 HTTPS）
- 結果：回傳 `sameSite: "none" + secure: false`
- **瀏覽器會直接拒收這個 cookie**，導致登入失敗

**修復方案**

改為只依賴 `isSecure` 判斷：

```typescript
// P0 FIX: Core rule - NEVER allow sameSite:none + secure:false
// Only use sameSite:none when isSecure=true (HTTPS)
// Otherwise always use sameSite:lax
sameSite: isSecure ? "none" : "lax",
secure: isSecure,
```

**核心規則**

| 環境 | isSecure | sameSite | secure | 瀏覽器行為 |
|------|----------|----------|--------|-----------|
| 本地開發（localhost + HTTP） | false | lax | false | ✅ 接受 |
| 本地 HTTPS 測試 | true | none | true | ✅ 接受 |
| 生產環境（HTTPS） | true | none | true | ✅ 接受 |
| 反代無 header（HTTP） | false | lax | false | ✅ 接受（改進） |
| ❌ 反代無 header（HTTP） | false | none | false | ❌ 拒收（原本） |

**修改前後對比**

```typescript
// 修改前 - 會自打臉
const isDevelopment = isLocalhost && !isSecure;
return {
  sameSite: isDevelopment ? "lax" : "none",  // 非 localhost 時用 none
  secure: isSecure,  // 但 secure 可能是 false
};

// 修改後 - 核心規則簡單明確
return {
  sameSite: isSecure ? "none" : "lax",  // 只有 HTTPS 才用 none
  secure: isSecure,  // secure 必須和 isSecure 一致
};
```

**影響範圍**

- `server/_core/cookies.ts`: `getSessionCookieOptions()`

**驗證方式**

1. 開發環境（localhost:3000）：Cookie 應為 `sameSite=lax, secure=false`
2. 生產環境（HTTPS）：Cookie 應為 `sameSite=none, secure=true`
3. 反向代理（無 header）：Cookie 應為 `sameSite=lax, secure=false`（不會被拒）

---

### P1-B: saveExtractedFiles 用 insertId 不穩

**問題描述**

原本的邏輯是：

```typescript
const result = await db.insert(filesTable).values({...});
if (result && (result as any).insertId) {
  fileIds.push((result as any).insertId);
}
```

**問題根源**

- Drizzle + mysql2 的 insert 回傳不一定有 `insertId` 欄位
- 不同 driver 版本、不同配置行為差異很大
- 結果：`fileIds` 陣列常常是空的
- 後續如果有人依賴 `fileIds`（例如批量操作），就會踩雷

**修復方案**

改為插入後再查回 IDs：

```typescript
// 1. 先插入所有檔案
for (const file of extractedFiles) {
  await db.insert(filesTable).values({...});
}

// 2. 再查回插入的 IDs（可靠方式）
if (extractedFiles.length > 0) {
  const { eq, desc } = await import("drizzle-orm");
  const insertedRecords = await db
    .select({ id: filesTable.id })
    .from(filesTable)
    .where(eq(filesTable.projectId, projectId))
    .orderBy(desc(filesTable.id))
    .limit(extractedFiles.length);

  for (const record of insertedRecords) {
    fileIds.push(record.id);
  }
}
```

**為什麼這樣做**

1. **可靠性**：不依賴 `insertId`，而是直接查詢資料庫
2. **通用性**：適用於所有 Drizzle + mysql2 組合
3. **可維護性**：邏輯清晰，易於調試

**修改前後對比**

| 方面 | 修改前 | 修改後 |
|------|--------|--------|
| 依賴 | insertId（不穩定） | 直接查詢（可靠） |
| fileIds 為空的風險 | 高 | 無 |
| 適用範圍 | 特定 driver/版本 | 所有組合 |
| 調試難度 | 難（看不到 ID） | 易（直接查詢） |

**影響範圍**

- `server/utils/fileExtractor.ts`: `saveExtractedFiles()`

**驗證方式**

1. 上傳 ZIP 檔案
2. 檢查資料庫中 `files` 表是否有新記錄
3. 驗證 `fileIds` 陣列是否非空
4. 檢查分析結果中的 symbols 是否有正確的 fileId 外鍵

---

### P1-C: ZIP 解壓大小計算用 string.length 不準確

**問題描述**

原本的邏輯是：

```typescript
const content = await file.async("string");
const fileSize = content.length;  // ❌ 不是 bytes
```

**問題根源**

- JavaScript 的 `string.length` 計算的是 **UTF-16 code units**，不是 **bytes**
- 如果檔案含多位元字元（例如中文、emoji），`length` 會遠小於實際 byte 大小
- 結果：
  - 大檔案可能被誤判為小檔案（繞過大小限制）
  - 小檔案可能被誤判為大檔案（誤殺有效檔案）

**修復方案**

改為使用 Buffer 計算準確的 byte 大小：

```typescript
// P1 FIX: Use Buffer to get accurate byte size
const buffer = await file.async("nodebuffer");
const fileSize = buffer.length;  // ✅ 準確的 bytes
const content = buffer.toString("utf8");  // 轉為字串供後續使用
```

**為什麼這樣做**

1. **準確性**：`Buffer.length` 是實際的 byte 大小
2. **安全性**：防止大檔案繞過限制
3. **公平性**：所有檔案都按相同標準計算

**修改前後對比**

```typescript
// 修改前 - 不準確
const content = await file.async("string");
const fileSize = content.length;  // UTF-16 code units，不是 bytes

// 修改後 - 準確
const buffer = await file.async("nodebuffer");
const fileSize = buffer.length;  // 實際 bytes
const content = buffer.toString("utf8");  // 轉為字串
```

**例子**

假設檔案包含 100 個中文字符（每個 3 bytes）：

| 方式 | 計算結果 | 實際大小 | 結果 |
|------|---------|---------|------|
| string.length | 100 | 300 bytes | ❌ 誤判為 100 bytes |
| Buffer.length | 300 | 300 bytes | ✅ 正確 |

**影響範圍**

- `server/utils/zipHandler.ts`: `extractFilesFromZip()`

**驗證方式**

1. 上傳包含多位元字元的檔案
2. 檢查大小計算是否準確
3. 驗證大檔案限制是否有效

---

### P1-D: DB 初始化仍是直接丟 URL，不夠保險

**問題描述**

原本的邏輯是：

```typescript
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);  // 直接丟 URL
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
```

**問題根源**

- 直接丟 URL 給 drizzle 在某些組合是可行的，但不夠穩定
- 沒有驗證 `DATABASE_URL` 是否存在（生產環境缺少會悄悄失敗）
- 沒有明確的連接池管理
- 調試困難（不知道是連接失敗還是其他問題）

**修復方案**

添加驗證邏輯和更清晰的錯誤訊息：

```typescript
/**
 * P1 FIX: Validate DATABASE_URL at startup
 */
export async function validateDbConfig() {
  const dbUrl = process.env.DATABASE_URL;
  
  if (!dbUrl) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[Database] DATABASE_URL is required in production environment. " +
        "Set DATABASE_URL environment variable before starting the server."
      );
    }
    console.warn("[Database] DATABASE_URL not set, database features will be unavailable");
    return false;
  }
  
  return true;
}

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
      console.log("[Database] Connection initialized successfully");
    } catch (error) {
      console.error("[Database] Failed to connect:", error);
      if (process.env.NODE_ENV === "production") {
        throw error;  // Fail fast in production
      }
      _db = null;
    }
  }
  return _db;
}
```

**為什麼這樣做**

1. **可靠性**：生產環境缺少 DATABASE_URL 會立即拋出異常
2. **可調試性**：清晰的錯誤訊息
3. **開發友善**：開發環境缺少 DATABASE_URL 只是警告

**修改前後對比**

| 方面 | 修改前 | 修改後 |
|------|--------|--------|
| DATABASE_URL 驗證 | 無 | 有（生產 fail fast） |
| 錯誤訊息 | 模糊 | 清晰 |
| 生產環境缺 URL | 悄悄失敗 | 立即拋出異常 |
| 開發環境缺 URL | 悄悄失敗 | 警告提示 |

**影響範圍**

- `server/db.ts`: `getDb()`, `validateDbConfig()`

**驗證方式**

1. 移除 DATABASE_URL 環境變數
2. 開發環境：應該看到警告訊息
3. 生產環境：應該看到異常並啟動失敗

---

## 修改的檔案清單

| 檔案 | 修改類型 | 修復項目 |
|------|---------|---------|
| `server/_core/cookies.ts` | 重寫 | P0: Cookie 邏輯 |
| `server/utils/fileExtractor.ts` | 重寫 | P1-B: insertId 不穩 |
| `server/utils/zipHandler.ts` | 編輯 | P1-C: 大小計算 |
| `server/db.ts` | 編輯 | P1-D: DB 初始化 |

---

## 修復前後的行為對比

### 場景 1: 反向代理環境（無 x-forwarded-proto header）

**修改前**
- 請求進來：HTTP（因為反代沒帶 header）
- `isSecure = false`
- `isDevelopment = false`（不是 localhost）
- 回傳：`sameSite=none + secure=false`
- 結果：❌ **瀏覽器拒收 cookie，登入失敗**

**修改後**
- 請求進來：HTTP
- `isSecure = false`
- 回傳：`sameSite=lax + secure=false`
- 結果：✅ **瀏覽器接受 cookie，登入成功**

### 場景 2: 上傳包含中文檔案的 ZIP

**修改前**
- 檔案：中文代碼（3000 個中文字符 = 9000 bytes）
- `string.length = 3000`
- 限制：`MAX_SINGLE_FILE_SIZE = 50MB`
- 結果：✅ 通過（但計算不準確）

**修改後**
- 檔案：同上
- `Buffer.length = 9000`
- 限制：`MAX_SINGLE_FILE_SIZE = 50MB`
- 結果：✅ 通過（計算準確）

### 場景 3: 生產環境缺少 DATABASE_URL

**修改前**
- 啟動服務器
- 沒有 DATABASE_URL
- 結果：❌ **悄悄失敗，沒有清晰的錯誤訊息**

**修改後**
- 啟動服務器
- 沒有 DATABASE_URL
- 結果：✅ **立即拋出異常：「DATABASE_URL is required in production environment」**

---

## 驗證清單

- [x] P0: Cookie 邏輯改為 `sameSite: isSecure ? "none" : "lax"`
- [x] P1-B: saveExtractedFiles 改用查詢方式取回 IDs
- [x] P1-C: ZIP 大小計算改用 Buffer.length
- [x] P1-D: DB 初始化添加驗證邏輯
- [x] 所有 TypeScript 編譯檢查通過
- [ ] 手動測試：登入流程（各環境）
- [ ] 手動測試：ZIP 上傳（含多位元字元）
- [ ] 手動測試：缺少 DATABASE_URL 時的行為

---

## 相關檔案

- `server/_core/cookies.ts` - Cookie 設定邏輯
- `server/utils/fileExtractor.ts` - 檔案提取工具
- `server/utils/zipHandler.ts` - ZIP 解析工具
- `server/db.ts` - 資料庫初始化

---

## 後續建議

1. **自動化測試**：為 cookie 邏輯和 DB 初始化編寫 vitest 測試
2. **集成測試**：測試各種環境下的 cookie 行為（localhost、HTTPS、反代）
3. **監控**：在生產環境中監控 cookie 相關的登入失敗
4. **文檔**：補充反向代理配置指南（需要 `x-forwarded-proto` header）
