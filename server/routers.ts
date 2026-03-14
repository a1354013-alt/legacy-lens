import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { eq, and } from "drizzle-orm";
import { projects, analysisResults, risks, symbols } from "../drizzle/schema";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // Legacy Lens: 程式碼考古與規則文件生成器
  projects: router({
    // 獲取使用者的所有專案
    list: publicProcedure.query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return [];
      if (!ctx.user) return [];
      return db.select().from(projects).where(eq(projects.userId, ctx.user.id));
    }),

    // 獲取單個專案詳情
    getById: publicProcedure
      .input(async (val) => {
        if (typeof val === "number") return val;
        throw new Error("Invalid input");
      })
      .query(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) return null;
        if (!ctx.user) return null;
        const result = await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, input),
              eq(projects.userId, ctx.user.id)
            )
          )
          .limit(1);
        return result[0] || null;
      }),

    // 建立新專案
    create: publicProcedure
      .input(async (val) => {
        if (
          typeof val === "object" &&
          val !== null &&
          "name" in val &&
          "language" in val &&
          "sourceType" in val
        ) {
          return val as {
            name: string;
            language: string;
            sourceType: string;
            description?: string;
          };
        }
        throw new Error("Invalid input");
      })
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        if (!ctx.user) throw new Error("Not authenticated");
        await db.insert(projects).values({
          userId: ctx.user.id,
          name: input.name,
          language: input.language as any,
          sourceType: input.sourceType as any,
          description: input.description,
          status: "pending",
        });
        return { success: true };
      }),

    // 刪除專案
    delete: publicProcedure
      .input(async (val) => {
        if (typeof val === "number") return val;
        throw new Error("Invalid input");
      })
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        if (!ctx.user) throw new Error("Not authenticated");
        await db
          .delete(projects)
          .where(
            and(
              eq(projects.id, input),
              eq(projects.userId, ctx.user.id)
            )
          );
        return { success: true };
      }),

    // 更新專案分析狀態
    updateStatus: publicProcedure
      .input(async (val) => {
        if (
          typeof val === "object" &&
          val !== null &&
          "projectId" in val &&
          "status" in val
        ) {
          return val as {
            projectId: number;
            status: string;
            progress?: number;
            errorMessage?: string;
          };
        }
        throw new Error("Invalid input");
      })
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        if (!ctx.user) throw new Error("Not authenticated");
        await db
          .update(projects)
          .set({
            status: input.status as any,
            analysisProgress: input.progress || 0,
            errorMessage: input.errorMessage,
          })
          .where(
            and(
              eq(projects.id, input.projectId),
              eq(projects.userId, ctx.user.id)
            )
          );
        return { success: true };
      }),
  }),

  analysis: router({
    // 獲取分析結果
    getResult: publicProcedure
      .input(async (val) => {
        if (typeof val === "number") return val;
        throw new Error("Invalid input");
      })
      .query(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) return null;
        if (!ctx.user) return null;

        // 驗證使用者有權訪問此專案
        const project = await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, input),
              eq(projects.userId, ctx.user.id)
            )
          )
          .limit(1);

        if (!project.length) throw new Error("Project not found");

        const result = await db
          .select()
          .from(analysisResults)
          .where(eq(analysisResults.projectId, input))
          .limit(1);

        return result[0] || null;
      }),

    // 獲取風險清單
    getRisks: publicProcedure
      .input(async (val) => {
        if (typeof val === "number") return val;
        throw new Error("Invalid input");
      })
      .query(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) return [];
        if (!ctx.user) return [];

        // 驗證使用者有權訪問此專案
        const project = await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, input),
              eq(projects.userId, ctx.user.id)
            )
          )
          .limit(1);

        if (!project.length) throw new Error("Project not found");

        return db.select().from(risks).where(eq(risks.projectId, input));
      }),

    // 獲取符號清單
    getSymbols: publicProcedure
      .input(async (val) => {
        if (typeof val === "number") return val;
        throw new Error("Invalid input");
      })
      .query(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) return [];
        if (!ctx.user) return [];

        // 驗證使用者有權訪問此專案
        const project = await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, input),
              eq(projects.userId, ctx.user.id)
            )
          )
          .limit(1);

        if (!project.length) throw new Error("Project not found");

        return db.select().from(symbols).where(eq(symbols.projectId, input));
      }),
  }),
});

export type AppRouter = typeof appRouter;
