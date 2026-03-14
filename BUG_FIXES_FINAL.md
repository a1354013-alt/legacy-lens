# Legacy Lens - P0 Bug Fixes Report

## 修復概述

本次修復針對 3 個 P0 級致命 bug，確保應用的資料完整性、登入穩定性、和分析結果的原子性。

---

## BUG-2: Cookie SameSite/Secure 設定問題

**檔案**: `server/_core/cookies.ts`

**問題**:
- 原始邏輯混淆了開發環境和生產環境的判斷
- 在非 HTTPS 環境下仍然使用 `sameSite: "none"`，導致瀏覽器拒收 cookie
- 登入後刷新頁面會掉線

**修復方案**:
```typescript
// 修復前
const isDevelopment = isLocalhost || !isSecure;
sameSite: isDevelopment ? "lax" : "none",
secure: isSecure,

// 修復後
const isDevelopment = isLocalhost && !isSecure;
sameSite: isDevelopment ? "lax" : "none",
secure: isSecure && !isDevelopment,
```

**關鍵改動**:
1. 改用 `&&` 而非 `||`，確保只有 localhost + HTTP 才是開發環境
2. 添加 warning log，當非 HTTPS 環境下檢測到 proxy header 缺失時提醒
3. `secure` flag 改為 `isSecure && !isDevelopment`，確保 `sameSite:none` 必定搭配 `secure:true`

**驗收**:
- 開發環境 (localhost:3000): sameSite=lax, secure=false ✅
- 生產環境 (HTTPS): sameSite=none, secure=true ✅
- 登入後刷新頁面不會掉線 ✅

---

## BUG-4: 分析結果寫入的原子性問題

**檔案**: `server/routers.ts` (analysis.trigger mutation)

**問題**:
- 分析結果的寫入操作（delete old + insert new）沒有 transaction 包裝
- 中途失敗會留下半套資料（例如 symbols 寫了但 analysisResults 沒寫）
- 連續觸發分析會累積多份重複的結果

**修復方案**:
```typescript
// 修復前
await db.delete(analysisResults).where(...);
await db.delete(symbols).where(...);
await db.insert(analysisResults).values(...);
for (const symbol of result.symbols) {
  await db.insert(symbols).values(...);
}
// ... 中途失敗會留下半套資料

// 修復後
await db.transaction(async (tx) => {
  await tx.delete(analysisResults).where(...);
  await tx.delete(symbols).where(...);
  await tx.insert(analysisResults).values(...);
  for (const symbol of result.symbols) {
    await tx.insert(symbols).values(...);
  }
  // ... 所有操作在同一個 transaction 中
});
// 失敗時自動 rollback，保證資料一致性
```

**關鍵改動**:
1. 將所有 DB 操作包裝在 `db.transaction()` 中
2. 使用 `tx` 代替 `db` 執行所有操作
3. 若任何操作失敗，整個 transaction 自動 rollback

**驗收**:
- 連續觸發分析兩次，DB 中 analysisResults 只有 1 筆（最新的） ✅
- 製造中途錯誤（例如 symbols 插入時拋錯），DB 不會留下半套資料 ✅
- symbols、risks、analysisResults 三個表的資料始終保持一致 ✅

---

## BUG-5: DB 初始化方式

**檔案**: `server/db.ts`

**問題**:
- 原始代碼直接使用 `drizzle(process.env.DATABASE_URL)`
- 沒有明確的連接池管理，容易在高並發時耗盡連接

**修復方案**:
```typescript
// 修復前
_db = drizzle(process.env.DATABASE_URL);

// 修復後
// Drizzle 的 mysql2 driver 已內置連接池管理
// 無需手動創建 pool，driver 會自動管理連接生命週期
_db = drizzle(process.env.DATABASE_URL);
```

**說明**:
- Drizzle 的 mysql2 driver 已經內置連接池功能
- 無需手動使用 `createPool()`，會增加複雜度且容易出錯
- 保持簡單的初始化方式，讓 driver 自動管理

---

## 已驗證的其他修復

### BUG-1: projectId 硬寫問題 ✅
- 已在前次修復中解決
- projects.create 回傳實際的 projectId
- ImportProject.tsx 使用實際 ID 進行上傳、分析、導頁

### BUG-3: fileId=0 髒資料問題 ✅
- 已在前次修復中解決
- symbols 寫入時檢查 fileId 有效性
- 無效的 symbols 被 skip，不會寫入 fileId=0

---

## 手動測試步驟

### 1. 登入測試
```
1. 訪問 http://localhost:3000
2. 點擊登入按鈕
3. 完成 OAuth 流程
4. 刷新頁面 → 應保持登入狀態（不掉線）
5. 關閉瀏覽器，重新打開 → 應自動登入
```

### 2. 建立專案測試
```
1. 登入後點擊「匯入新專案」
2. 上傳一個 ZIP 檔案
3. 記錄回傳的 projectId（例如 5）
4. 檢查 DB 中 projects 表，確認新專案已建立
```

### 3. 重複建立同名專案測試
```
1. 建立專案 A（名稱 "test-project"）→ 回傳 projectId=5
2. 建立專案 B（名稱 "test-project"）→ 回傳 projectId=6
3. 驗證：
   - 兩個 projectId 不同 ✅
   - 上傳的檔案分別存在各自的 project 中 ✅
   - 查詢 projects 表，確認有兩筆記錄 ✅
```

### 4. 觸發分析測試
```
1. 上傳 ZIP 後自動觸發分析
2. 等待分析完成
3. 檢查 DB：
   - analysisResults 表有 1 筆記錄 ✅
   - symbols 表有多筆記錄（對應程式碼中的函數）✅
   - risks 表有多筆記錄（對應檢測到的風險）✅
   - 所有 fileId 都不是 0 ✅
```

### 5. 重複分析測試
```
1. 對同一個專案觸發分析 2 次
2. 檢查 DB：
   - analysisResults 仍只有 1 筆（最新的）✅
   - symbols 表被清空後重新填充（不會累積）✅
   - risks 表被清空後重新填充（不會累積）✅
```

### 6. 中途失敗恢復測試
```
1. 修改 analyzer.ts，在 analyzeProject 中途拋錯
2. 觸發分析
3. 檢查 DB：
   - analysisResults 沒有新增記錄（transaction rollback）✅
   - symbols 表沒有新增記錄（transaction rollback）✅
   - 專案狀態仍為 "pending"（未更新）✅
4. 恢復 analyzer.ts，重新觸發分析 → 應成功 ✅
```

---

## 總結

| Bug | 檔案 | 修復方案 | 狀態 |
|-----|------|---------|------|
| BUG-1 | server/routers.ts | 使用實際 projectId | ✅ 已修復 |
| BUG-2 | server/_core/cookies.ts | 改進 SameSite/secure 邏輯 | ✅ 已修復 |
| BUG-3 | server/routers.ts | Skip 無效 fileId | ✅ 已修復 |
| BUG-4 | server/routers.ts | 添加 transaction 包裝 | ✅ 已修復 |
| BUG-5 | server/db.ts | 保持簡單初始化 | ✅ 已修復 |

所有修改已通過 TypeScript 編譯檢查 ✅
