import { COOKIE_NAME, MAX_LEGACY_BASE64_ZIP_BYTES, formatBytes } from "@shared/const";
import {
  dependenciesPageInputSchema,
  fieldDependenciesPageInputSchema,
  fieldsPageInputSchema,
  focusLanguageSchema,
  impactTargetTypeSchema,
  projectSourceTypeSchema,
  risksPageInputSchema,
  rulesPageInputSchema,
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
      IMPORT_FAILED: "BAD_REQUEST",
      ANALYSIS_FAILED: "BAD_REQUEST",
      REPORT_NOT_READY: "BAD_REQUEST",
      REPORT_TOO_LARGE: "PAYLOAD_TOO_LARGE",
      DELETE_FAILED: "BAD_REQUEST",
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
    list: protectedProcedure.query(async ({ ctx }) => {
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

        return projectRows.map((project) => ({
          ...project,
          analysisStatus: deriveProjectAnalysisStatus(project.status, analysisStatusByProjectId.get(project.id)),
          latestJob: latestJobsByProjectId.get(project.id) ?? null,
        }));
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getById: protectedProcedure.input(projectIdSchema).query(async ({ ctx, input }) => {
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

        return {
          ...project,
          analysisStatus: deriveProjectAnalysisStatus(project.status, report?.status),
          latestJob: latestJobsByProjectId.get(input) ?? null,
        };
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    create: protectedProcedure.input(createProjectSchema).mutation(async ({ ctx, input }) => {
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

    delete: protectedProcedure.input(projectIdSchema).mutation(async ({ ctx, input }) => {
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
    getById: protectedProcedure.input(z.number().int().positive()).query(async ({ ctx, input }) => {
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

    getResult: protectedProcedure.input(projectIdSchema).query(async ({ ctx, input }) => {
      try {
        return await getAnalysisResult(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getSnapshot: protectedProcedure.input(projectIdSchema).query(async ({ ctx, input }) => {
      try {
        return await getAnalysisSnapshot(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getSymbolsPage: protectedProcedure.input(symbolsPageInputSchema).query(async ({ ctx, input }) => {
      try {
        return await getSymbolsPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getFieldsPage: protectedProcedure.input(fieldsPageInputSchema).query(async ({ ctx, input }) => {
      try {
        return await getFieldsPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getRisksPage: protectedProcedure.input(risksPageInputSchema).query(async ({ ctx, input }) => {
      try {
        return await getRisksPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getRulesPage: protectedProcedure.input(rulesPageInputSchema).query(async ({ ctx, input }) => {
      try {
        return await getRulesPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getDependenciesPage: protectedProcedure.input(dependenciesPageInputSchema).query(async ({ ctx, input }) => {
      try {
        return await getDependenciesPage(input, ctx.user.id);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getFieldDependenciesPage: protectedProcedure.input(fieldDependenciesPageInputSchema).query(async ({ ctx, input }) => {
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
