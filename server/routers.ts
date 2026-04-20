import { COOKIE_NAME } from "@shared/const";
import { focusLanguageSchema, projectSourceTypeSchema } from "@shared/contracts";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { analysisResults, projects, risks, symbols } from "../drizzle/schema";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { AppError } from "./appError";
import { getDb } from "./db";
import {
  analyzeProject,
  buildReportArchive,
  createProjectForUser,
  deleteProjectCascade,
  getAnalysisResult,
  getAnalysisSnapshot,
  getOwnedProject,
  importProjectGit,
  importProjectZip,
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
  zipContent: z.string().min(1),
});

const cloneGitSchema = z.object({
  projectId: projectIdSchema,
  gitUrl: z.string().trim().min(1),
});

function raiseAsTrpc(error: unknown): never {
  if (error instanceof TRPCError) {
    throw error;
  }

  if (error instanceof AppError) {
    const codeMap: Record<AppError["code"], TRPCError["code"]> = {
      DATABASE_UNAVAILABLE: "INTERNAL_SERVER_ERROR",
      PROJECT_NOT_FOUND: "NOT_FOUND",
      INVALID_PROJECT_STATE: "BAD_REQUEST",
      INVALID_GIT_URL: "BAD_REQUEST",
      GIT_CLONE_FAILED: "BAD_REQUEST",
      EMPTY_SOURCE: "BAD_REQUEST",
      ZIP_INVALID: "BAD_REQUEST",
      IMPORT_FAILED: "BAD_REQUEST",
      ANALYSIS_FAILED: "BAD_REQUEST",
      REPORT_NOT_READY: "BAD_REQUEST",
      DELETE_FAILED: "BAD_REQUEST",
    };

    throw new TRPCError({
      code: codeMap[error.code],
      message: error.message,
      cause: error,
    });
  }

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "Unexpected server error.",
    cause: error instanceof Error ? error : undefined,
  });
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

        const [projectRows, reportRows] = await Promise.all([
          db.select().from(projects).where(eq(projects.userId, ctx.user.id)).orderBy(desc(projects.id)),
          db.select({ projectId: analysisResults.projectId, status: analysisResults.status }).from(analysisResults),
        ]);

        const analysisStatusByProjectId = new Map(reportRows.map((row) => [row.projectId, row.status]));
        return projectRows.map((project) => ({
          ...project,
          analysisStatus: analysisStatusByProjectId.get(project.id) ?? "pending",
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

        return {
          ...project,
          analysisStatus: report?.status ?? "pending",
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

    uploadFiles: protectedProcedure.input(uploadFilesSchema).mutation(async ({ ctx, input }) => {
      try {
        const result = await importProjectZip(input.projectId, ctx.user.id, input.zipContent);
        return {
          success: true,
          fileCount: result.files.length,
          fileIds: result.fileIds,
          files: result.files,
          warnings: result.warnings,
        };
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    cloneGit: protectedProcedure.input(cloneGitSchema).mutation(async ({ ctx, input }) => {
      try {
        const result = await importProjectGit(input.projectId, ctx.user.id, input.gitUrl);
        return {
          success: true,
          fileCount: result.files.length,
          fileIds: result.fileIds,
          files: result.files,
          warnings: result.warnings,
        };
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),
  }),

  analysis: router({
    trigger: protectedProcedure.input(projectIdSchema).mutation(async ({ ctx, input }) => {
      try {
        const result = await analyzeProject(input, ctx.user.id);
        return {
          success: true,
          status: result.status,
          riskScore: result.riskScore,
          metrics: result.metrics,
          warnings: result.warnings,
        };
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

    getRisks: protectedProcedure.input(projectIdSchema).query(async ({ ctx, input }) => {
      try {
        const db = await getDb();
        if (!db) return [];
        await getOwnedProject(input, ctx.user.id);
        return await db.select().from(risks).where(eq(risks.projectId, input)).orderBy(desc(risks.id));
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    getSymbols: protectedProcedure.input(projectIdSchema).query(async ({ ctx, input }) => {
      try {
        const db = await getDb();
        if (!db) return [];
        await getOwnedProject(input, ctx.user.id);
        return await db.select().from(symbols).where(eq(symbols.projectId, input)).orderBy(symbols.startLine);
      } catch (error) {
        raiseAsTrpc(error);
      }
    }),

    downloadReport: protectedProcedure
      .input(z.object({ projectId: projectIdSchema, format: z.literal("zip").default("zip") }))
      .query(async ({ ctx, input }) => {
        try {
          return await buildReportArchive(input.projectId, ctx.user.id);
        } catch (error) {
          raiseAsTrpc(error);
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
