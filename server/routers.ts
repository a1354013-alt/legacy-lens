import { COOKIE_NAME, MAX_LEGACY_BASE64_ZIP_BYTES, formatBytes } from "@shared/const";
import {
  analysisResultOutputSchema,
  analysisSnapshotOutputSchema,
  dependenciesPageOutputSchema,
  fieldDependenciesPageOutputSchema,
  dependenciesPageInputSchema,
  fieldsPageOutputSchema,
  fieldDependenciesPageInputSchema,
  fieldsPageInputSchema,
  focusLanguageSchema,
  impactTargetTypeSchema,
  impactAnalysisResultSchema,
  jobByIdOutputSchema,
  projectByIdOutputSchema,
  projectCreateOutputSchema,
  projectDeleteOutputSchema,
  projectsListOutputSchema,
  projectSourceTypeSchema,
  reportArchivePayloadSchema,
  risksPageOutputSchema,
  risksPageInputSchema,
  rulesPageOutputSchema,
  rulesPageInputSchema,
  symbolsPageOutputSchema,
  symbolsPageInputSchema,
  type AnalysisStatus,
  type ProjectStatus,
} from "@shared/contracts";
import { TRPCError } from "@trpc/server";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { analysisResults, projects } from "../drizzle/schema";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { AppError } from "./appError";
import { getDb } from "./db";
import { logger } from "./_core/logger";
import {
  buildReportArchive,
  createProjectForUser,
  deleteProjectCascade,
  getAnalysisResult,
  getAnalysisSnapshot,
  getDependenciesPage,
  getFieldDependenciesPage,
  getFieldsPage,
  getLatestJobsByProjectIds,
  getOwnedProject,
  getProjectJob,
  getRisksPage,
  getRulesPage,
  getSymbolsPage,
  queueAnalyzeProject,
  queueImportProjectGit,
  queueImportProjectZip,
  runImpactAnalysis,
} from "./services/projectWorkflow";

const projectIdSchema = z.number().int().positive();

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(255),
  focusLanguage: focusLanguageSchema,
  sourceType: projectSourceTypeSchema,
  description: z.string().trim().max(2_000).optional(),
});

const uploadFilesSchema = z.object({
  projectId: projectIdSchema,
  zipContent: z.string().min(1).refine((value) => Buffer.from(value, "base64").length <= MAX_LEGACY_BASE64_ZIP_BYTES, {
    message: `Legacy ZIP upload is limited to ${formatBytes(MAX_LEGACY_BASE64_ZIP_BYTES)}. Use the multipart /api/projects/:projectId/upload route for normal imports.`,
  }),
});

const cloneGitSchema = z.object({
  projectId: projectIdSchema,
  gitUrl: z.string().trim().min(1),
});

function deriveProjectAnalysisStatus(projectStatus: ProjectStatus, reportStatus?: AnalysisStatus): AnalysisStatus {
  if (reportStatus) {
    return reportStatus;
  }

  switch (projectStatus) {
    case "analyzing":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

export function toTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) {
    return error;
  }

  if (error instanceof AppError) {
    const codeMap: Record<AppError["code"], TRPCError["code"]> = {
      DATABASE_UNAVAILABLE: "INTERNAL_SERVER_ERROR",
      PROJECT_NOT_FOUND: "NOT_FOUND",
      PROJECT_JOB_NOT_FOUND: "NOT_FOUND",
      PROJECT_JOB_ACTIVE: "CONFLICT",
      PROJECT_JOB_STALE: "INTERNAL_SERVER_ERROR",
      INVALID_PROJECT_STATE: "BAD_REQUEST",
      INVALID_GIT_URL: "BAD_REQUEST",
      GIT_CLONE_FAILED: "BAD_REQUEST",
      EMPTY_SOURCE: "BAD_REQUEST",
      ZIP_INVALID: "BAD_REQUEST",
      ZIP_UNSAFE_PATH: "BAD_REQUEST",
      IMPORT_FAILED: "INTERNAL_SERVER_ERROR",
      ANALYSIS_FAILED: "INTERNAL_SERVER_ERROR",
      REPORT_NOT_READY: "CONFLICT",
      REPORT_TOO_LARGE: "PAYLOAD_TOO_LARGE",
      DELETE_FAILED: "CONFLICT",
    };

    return new TRPCError({
      code: codeMap[error.code],
      message: error.message,
      cause: error,
    });
  }

  logger.error("Unhandled router error", {
    action: "trpc.error",
    status: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: process.env.NODE_ENV === "production" ? "Internal server error" : error instanceof Error ? error.message : "Unexpected server error.",
    cause: error instanceof Error ? error : undefined,
  });
}

function raiseAsTrpc(error: unknown): never {
  throw toTrpcError(error);
}

function toProjectSummary(
  project: Awaited<ReturnType<typeof getOwnedProject>> | Record<string, unknown>,
  analysisStatus: AnalysisStatus,
  latestJob: ReturnType<typeof getLatestJobsByProjectIds> extends Promise<Map<number, infer T>> ? T | null : never
) {
  return {
    id: Number(project.id),
    userId: Number(project.userId),
    name: String(project.name ?? ""),
    description: typeof project.description === "string" ? project.description : null,
    language: project.language as ReturnType<typeof focusLanguageSchema.parse>,
    sourceType: project.sourceType as ReturnType<typeof projectSourceTypeSchema.parse>,
    sourceUrl: typeof project.sourceUrl === "string" ? project.sourceUrl : null,
    status: project.status as ProjectStatus,
    importProgress: Number(project.importProgress ?? 0),
    analysisProgress: Number(project.analysisProgress ?? 0),
    errorMessage: typeof project.errorMessage === "string" ? project.errorMessage : null,
    lastErrorCode: typeof project.lastErrorCode === "string" ? project.lastErrorCode : null,
    importWarningsJson: Array.isArray(project.importWarningsJson) ? project.importWarningsJson : [],
    lastAnalyzedAt: project.lastAnalyzedAt instanceof Date ? project.lastAnalyzedAt : project.lastAnalyzedAt ? new Date(String(project.lastAnalyzedAt)) : null,
    createdAt: project.createdAt instanceof Date ? project.createdAt : project.createdAt ? new Date(String(project.createdAt)) : new Date(0),
    updatedAt: project.updatedAt instanceof Date ? project.updatedAt : project.updatedAt ? new Date(String(project.updatedAt)) : new Date(0),
    analysisStatus,
    latestJob: latestJob ?? null,
  };
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  projects: router({
    list: protectedProcedure.output(projectsListOutputSchema).query(async ({ ctx }) => {
      try {
        const db = await getDb();
        if (!db) return [];

        const projectRows = await db.select().from(projects).where(eq(projects.userId, ctx.user.id)).orderBy(desc(projects.id));
        if (projectRows.length === 0) {
          return [];
        }

        const reportRows = await db
          .select({ projectId: analysisResults.projectId, status: analysisResults.status })
          .from(analysisResults)
          .where(inArray(analysisResults.projectId, projectRows.map((project) => project.id)));

        const analysisStatusByProjectId = new Map(reportRows.map((row) => [row.projectId, row.status]));
        const latestJobsByProjectId = await getLatestJobsByProjectIds(projectRows.map((project) => project.id), ctx.user.id);

        const visibleProjectRows = projectRows.filter((project) => project.status !== "draft" || latestJobsByProjectId.has(project.id));

        return visibleProjectRows.map((project) =>
          toProjectSummary(
            project,
            deriveProjectAnalysisStatus(project.status, analysisStatusByProjectId.get(project.id)),
            latestJobsByProjectId.get(project.id) ?? null
          )
        );
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getById: protectedProcedure.input(projectIdSchema).output(projectByIdOutputSchema).query(async ({ ctx, input }) => {
      try {
        const db = await getDb();
        if (!db) return null;

        const project = await getOwnedProject(input, ctx.user.id);
        const [report] = await db
          .select({ status: analysisResults.status })
          .from(analysisResults)
          .where(eq(analysisResults.projectId, input))
          .limit(1);

        const latestJobsByProjectId = await getLatestJobsByProjectIds([input], ctx.user.id);

        return toProjectSummary(project, deriveProjectAnalysisStatus(project.status, report?.status), latestJobsByProjectId.get(input) ?? null);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    create: protectedProcedure.input(createProjectSchema).output(projectCreateOutputSchema).mutation(async ({ ctx, input }) => {
      try {
        const projectId = await createProjectForUser(ctx.user.id, {
          name: input.name,
          focusLanguage: input.focusLanguage,
          sourceType: input.sourceType,
          description: input.description,
        });
        return { success: true, projectId };
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    delete: protectedProcedure.input(projectIdSchema).output(projectDeleteOutputSchema).mutation(async ({ ctx, input }) => {
      try {
        await deleteProjectCascade(input, ctx.user.id);
        return { success: true };
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    // Legacy-only small ZIP upload path kept for backwards compatibility.
    // The main UI uses the multipart upload route so large archives never need to be base64-encoded into JSON.
    uploadFiles: protectedProcedure.input(uploadFilesSchema).mutation(async ({ ctx, input }) => {
      try {
        return await queueImportProjectZip(input.projectId, ctx.user.id, input.zipContent);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    cloneGit: protectedProcedure.input(cloneGitSchema).mutation(async ({ ctx, input }) => {
      try {
        return await queueImportProjectGit(input.projectId, ctx.user.id, input.gitUrl);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),
  }),

  jobs: router({
    getById: protectedProcedure.input(z.number().int().positive()).output(jobByIdOutputSchema).query(async ({ ctx, input }) => {
      try {
        return await getProjectJob(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),
  }),

  analysis: router({
    trigger: protectedProcedure.input(projectIdSchema).mutation(async ({ ctx, input }) => {
      try {
        return await queueAnalyzeProject(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getResult: protectedProcedure.input(projectIdSchema).output(analysisResultOutputSchema).query(async ({ ctx, input }) => {
      try {
        return await getAnalysisResult(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getSnapshot: protectedProcedure.input(projectIdSchema).output(analysisSnapshotOutputSchema).query(async ({ ctx, input }) => {
      try {
        return await getAnalysisSnapshot(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getSymbolsPage: protectedProcedure.input(symbolsPageInputSchema).output(symbolsPageOutputSchema).query(async ({ ctx, input }) => {
      try {
        return await getSymbolsPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getFieldsPage: protectedProcedure.input(fieldsPageInputSchema).output(fieldsPageOutputSchema).query(async ({ ctx, input }) => {
      try {
        return await getFieldsPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getRisksPage: protectedProcedure.input(risksPageInputSchema).output(risksPageOutputSchema).query(async ({ ctx, input }) => {
      try {
        return await getRisksPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getRulesPage: protectedProcedure.input(rulesPageInputSchema).output(rulesPageOutputSchema).query(async ({ ctx, input }) => {
      try {
        return await getRulesPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getDependenciesPage: protectedProcedure.input(dependenciesPageInputSchema).output(dependenciesPageOutputSchema).query(async ({ ctx, input }) => {
      try {
        return await getDependenciesPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getFieldDependenciesPage: protectedProcedure.input(fieldDependenciesPageInputSchema).output(fieldDependenciesPageOutputSchema).query(async ({ ctx, input }) => {
      try {
        return await getFieldDependenciesPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    // DEPRECATED: Use GET /api/projects/:projectId/report.zip instead
    // This tRPC query remains available only for backward compatibility
    // HTTP ZIP download is preferred to avoid base64 encoding overhead
    downloadReport: protectedProcedure
      .input(z.object({ projectId: projectIdSchema, format: z.literal("zip").default("zip") }))
      .output(reportArchivePayloadSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await buildReportArchive(input.projectId, ctx.user.id);
        } catch (error) {
          raiseAsTrpc(error);
        }
      }),

    getImpact: protectedProcedure
      .input(
        z.object({
          projectId: projectIdSchema,
          target: z.string().min(1),
          type: impactTargetTypeSchema.default("auto"),
        })
      )
      .output(impactAnalysisResultSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await runImpactAnalysis(input.projectId, ctx.user.id, input.target, input.type);
        } catch (error) {
          raiseAsTrpc(error);
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
