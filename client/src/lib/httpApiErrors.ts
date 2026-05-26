import { httpApiErrorResponseSchema, type HttpApiErrorResponse } from "@shared/contracts";

export async function readHttpApiError(response: Response): Promise<HttpApiErrorResponse | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  const parsed = httpApiErrorResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function getImportUploadErrorMessage(
  status: number,
  payload: HttpApiErrorResponse | null,
  fallback = "上傳失敗，請稍後再試。"
) {
  if (payload?.code === "ZIP_UNSAFE_PATH") {
    return "ZIP 內含不安全路徑，整包已被拒絕。請修正壓縮檔後重新上傳。";
  }

  if (payload?.code === "PROJECT_JOB_ACTIVE" || status === 409) {
    return "此專案已有進行中的匯入或分析工作，請等待目前工作完成後再試。";
  }

  if (status === 413) {
    return "ZIP 檔案超過大小限制，請縮小壓縮檔後再試。";
  }

  if (status === 429) {
    return "上傳次數過於頻繁，請稍候再試。";
  }

  return payload?.message ?? payload?.error ?? fallback;
}

export function getReportDownloadErrorMessage(
  status: number,
  payload: HttpApiErrorResponse | null,
  fallback = "無法下載報告 ZIP。"
) {
  if (payload?.code === "REPORT_NOT_READY" || status === 409) {
    return "報告尚未準備完成，請等分析完成後再下載。";
  }

  if (payload?.code === "REPORT_TOO_LARGE" || status === 413) {
    return [payload?.message ?? payload?.error, payload?.remediation].filter(Boolean).join(" ");
  }

  if (payload?.code === "PROJECT_NOT_FOUND" || status === 404) {
    return "找不到指定專案，或你目前沒有存取權限。";
  }

  return payload?.message ?? payload?.error ?? fallback;
}
