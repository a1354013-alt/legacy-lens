import type { FocusLanguage, ProjectSourceType } from "@shared/contracts";

export type ImportUploadResponse = { projectId: number; jobId: number; jobType: "import_zip" | "import_git" };

export type ImportProjectSubmitInput = {
  projectName: string;
  description: string;
  focusLanguage: FocusLanguage;
  sourceType: ProjectSourceType;
  uploadedFile: File | null;
  gitUrl: string;
};

type FetchImport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ProjectsListUtils = {
  projects: {
    list: {
      invalidate: () => Promise<unknown> | unknown;
    };
  };
};

export function acquireSubmitLock(lock: { current: boolean }) {
  if (lock.current) {
    return false;
  }

  lock.current = true;
  return true;
}

export function releaseSubmitLock(lock: { current: boolean }) {
  lock.current = false;
}

export function buildImportProjectFormData(input: ImportProjectSubmitInput) {
  const formData = new FormData();
  formData.append("name", input.projectName.trim());
  formData.append("focusLanguage", input.focusLanguage);
  formData.append("sourceType", input.sourceType);

  if (input.description.trim()) {
    formData.append("description", input.description.trim());
  }

  if (input.sourceType === "upload" && input.uploadedFile) {
    formData.append("file", input.uploadedFile, input.uploadedFile.name);
  }

  if (input.sourceType === "git") {
    formData.append("gitUrl", input.gitUrl.trim());
  }

  return formData;
}

export async function submitImportProject(
  input: ImportProjectSubmitInput,
  readErrorMessage: (response: Response) => Promise<string>,
  fetchImport: FetchImport = fetch
) {
  const response = await fetchImport("/api/projects/import", {
    method: "POST",
    body: buildImportProjectFormData(input),
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as ImportUploadResponse;
}

export async function invalidateProjectsListAfterImportSuccess(utils: ProjectsListUtils) {
  await utils.projects.list.invalidate();
}
