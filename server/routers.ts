import { COOKIE_NAME } from "@shared/const";
import { useState, useRef } from "react";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { eq, and, desc } from "drizzle-orm";
import { projects, analysisResults, risks, symbols, files } from "../drizzle/schema";
import { Analyzer } from "./analyzer/analyzer";
import { z } from "zod";
import { extractFilesFromZip, validateZipFile } from "./utils/zipHandler";
import { saveExtractedFiles, deleteProjectFiles, getProjectFiles } from "./utils/fileExtractor";
import { isValidGitUrl, cloneAndExtractFiles, cleanupTempDir } from "./utils/gitHandler";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
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
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return [];
      if (!ctx.user) return [];
      return db.select().from(projects).where(eq(projects.userId, ctx.user.id));
    }),

    // 獲取單個專案詳情
    getById: protectedProcedure
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
    create: protectedProcedure
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
        // Insert and get the latest project ID (not by name, which can be duplicated)
        // Using desc order to get the most recently created project
        await db.insert(projects).values({
          userId: ctx.user.id,
          name: input.name,
          language: input.language as any,
          sourceType: input.sourceType as any,
          description: input.description,
          status: "pending",
        });
        
        // Get the newly created project ID by fetching the latest one for this user
        // This ensures we get the correct ID even if there are multiple projects with the same name
        const newProject = await db
          .select()
          .from(projects)
          .where(eq(projects.userId, ctx.user.id))
          .orderBy(desc(projects.id))
          .limit(1);
        
        const projectId = newProject[0]?.id;
        if (!projectId) throw new Error("Failed to get project ID");
        
        return { success: true, projectId };
      }),

    // 刪除專案
    delete: protectedProcedure
      .input(async (val) => {
        if (typeof val === "number") return val;
        throw new Error("Invalid input");
      })
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");
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

    // 從 Git 克隆並提取檔案
    cloneGit: protectedProcedure
      .input(async (val) => {
        if (
          typeof val === "object" &&
          val !== null &&
          "projectId" in val &&
          "gitUrl" in val &&
          typeof val.projectId === "number" &&
          typeof val.gitUrl === "string"
        ) {
          return val as {
            projectId: number;
            gitUrl: string;
          };
        }
        throw new Error("Invalid input");
      })
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        let tempDir = "";
        try {
          // 驗證使用者有權訪問此專案
          const project = await db
            .select()
            .from(projects)
            .where(
              and(
                eq(projects.id, input.projectId),
                eq(projects.userId, ctx.user.id)
              )
            )
            .limit(1);

          if (!project.length) throw new Error("Project not found");

          // 驗證 Git URL
          if (!isValidGitUrl(input.gitUrl)) {
            throw new Error("Invalid Git URL format");
          }

          // 更新專案狀態為分析中
          await db
            .update(projects)
            .set({
              status: "analyzing",
              analysisProgress: 10,
            })
            .where(eq(projects.id, input.projectId));

          // 建立臨時目錄
          tempDir = `/tmp/legacy-lens-${Date.now()}`;

          // 克隆並提取檔案
          const extractedFiles = await cloneAndExtractFiles(input.gitUrl, tempDir);

          // 刪除舊檔案（如果存在）
          await deleteProjectFiles(input.projectId);

          // 保存新檔案到資料庫
          const fileIds = await saveExtractedFiles(input.projectId, extractedFiles);

          // 更新進度
          await db
            .update(projects)
            .set({
              analysisProgress: 30,
            })
            .where(eq(projects.id, input.projectId));

          return {
            success: true,
            fileCount: extractedFiles.length,
            fileIds,
            files: extractedFiles.map((f) => ({
              path: f.path,
              fileName: f.fileName,
              language: f.language,
              size: f.size,
            })),
          };
        } catch (error) {
          // 更新專案狀態為失敗
          await db
            .update(projects)
            .set({
              status: "failed",
              errorMessage: error instanceof Error ? error.message : "Unknown error",
            })
            .where(eq(projects.id, input.projectId));

          throw error;
        } finally {
          // 清理臨時目錄
          if (tempDir) {
            await cleanupTempDir(tempDir);
          }
        }
      }),

    // 上傳 ZIP 檔案並保存檔案
    uploadFiles: protectedProcedure
      .input(async (val) => {
        if (
          typeof val === "object" &&
          val !== null &&
          "projectId" in val &&
          "zipContent" in val &&
          typeof val.projectId === "number" &&
          typeof val.zipContent === "string"
        ) {
          return val as {
            projectId: number;
            zipContent: string; // Base64 encoded ZIP
          };
        }
        throw new Error("Invalid input");
      })
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        try {
          // 驗證使用者有權訪問此專案
          const project = await db
            .select()
            .from(projects)
            .where(
              and(
                eq(projects.id, input.projectId),
                eq(projects.userId, ctx.user.id)
              )
            )
            .limit(1);

          if (!project.length) throw new Error("Project not found");

          // 驗證 ZIP 檔案
          const isValid = await validateZipFile(input.zipContent);
          if (!isValid) throw new Error("Invalid ZIP file");

          // 更新專案狀態為分析中
          await db
            .update(projects)
            .set({
              status: "analyzing",
              analysisProgress: 10,
            })
            .where(eq(projects.id, input.projectId));

          // 提取 ZIP 中的檔案
          const extractedFiles = await extractFilesFromZip(input.zipContent);

          // P0-A FIX: Wrap file operations in transaction and pass tx to both functions
          // If saveExtractedFiles fails, old files are preserved (not deleted)
          // This prevents data loss if upload fails midway
          const fileIds = await db.transaction(async (tx) => {
            // First, save new files to the transaction
            // If this succeeds, then delete old files
            const newFileIds = await saveExtractedFiles(input.projectId, extractedFiles, tx);
            
            // Only delete old files after new files are successfully saved
            // This way, if saveExtractedFiles fails, old files remain intact
            await deleteProjectFiles(input.projectId, tx);
            
            return newFileIds;
          });


          // 更新進度
          await db
            .update(projects)
            .set({
              analysisProgress: 30,
            })
            .where(eq(projects.id, input.projectId));

          return {
            success: true,
            fileCount: extractedFiles.length,
            fileIds,
            files: extractedFiles.map((f) => ({
              path: f.path,
              fileName: f.fileName,
              language: f.language,
              size: f.size,
            })),
          };
        } catch (error) {
          // 更新專案狀態為失敗
          await db
            .update(projects)
            .set({
              status: "failed",
              errorMessage: error instanceof Error ? error.message : "Unknown error",
            })
            .where(eq(projects.id, input.projectId));

          throw error;
        }
      }),

    // 更新專案分析狀態
    updateStatus: protectedProcedure
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
    // 觸發分析（使用資料庫中的檔案）
    trigger: protectedProcedure
      .input(async (val) => {
        if (typeof val === "number") return val;
        throw new Error("Invalid input");
      })
      .mutation(async ({ ctx, input: projectId }) => {
        try {
          const db = await getDb();
          if (!db) throw new Error("Database not available");

          // 驗證使用者有權訪問此專案
          const project = await db
            .select()
            .from(projects)
            .where(
              and(
                eq(projects.id, projectId),
                eq(projects.userId, ctx.user.id)
              )
            )
            .limit(1);

          if (!project.length) throw new Error("Project not found");

          // 從資料庫讀取專案的所有檔案
          const projectFiles = await getProjectFiles(projectId);

          if (projectFiles.length === 0) {
            throw new Error("No files found in project");
          }

          // 轉換檔案格式以供分析器使用
          const filesToAnalyze = projectFiles.map((f: any) => ({
            path: f.filePath,
            content: f.content || "",
            language: f.fileType?.replace(".", "") || "unknown",
          }));

          // 執行分析
          const analyzer = new Analyzer();
          const result = await analyzer.analyzeProject(filesToAnalyze, projectId);

          // BUG-4 FIX: Wrap all DB operations in a transaction to ensure atomicity
          // If any operation fails, all changes are rolled back
          // This prevents half-written analysis results from corrupting the DB
          await db.transaction(async (tx) => {
            // Delete old analysis results to avoid duplicate/stale data
            // This ensures we have a clean slate for the new analysis
            await tx
              .delete(analysisResults)
              .where(eq(analysisResults.projectId, projectId));
            
            await tx
              .delete(symbols)
              .where(eq(symbols.projectId, projectId));
            
            await tx
              .delete(risks)
              .where(eq(risks.projectId, projectId));
            
            // Save new analysis results
            await tx.insert(analysisResults).values({
              projectId: projectId,
              flowMarkdown: result.flowDocument,
              dataDependencyMarkdown: result.dataDependencyDocument,
              risksMarkdown: result.risksDocument,
              rulesYaml: result.rulesYaml,
            });

            // 保存符號
            for (const symbol of result.symbols) {
              // BUG-5 FIX: Normalize file paths for consistent matching
              // Convert backslashes to forward slashes and remove leading ./
              const normalizedSymbolPath = symbol.file
                .replace(/\\/g, "/")
                .replace(/^\.\//g, "");
              
              // Find matching file record with normalized path comparison
              const fileRecord = projectFiles.find((f: any) => {
                const normalizedDbPath = f.filePath
                  .replace(/\\/g, "/")
                  .replace(/^\.\//g, "");
                return normalizedDbPath === normalizedSymbolPath;
              });
              
              // Skip symbols with missing file references to avoid foreign key violations
              if (!fileRecord?.id) {
                console.warn(
                  `[Analysis] Symbol "${symbol.name}" skipped: file not found ` +
                  `(projectId=${projectId}, file="${symbol.file}")`
                );
                continue;
              }
              
              await tx.insert(symbols).values({
                projectId: projectId,
                fileId: fileRecord.id,
                name: symbol.name,
                type: symbol.type as any,
                startLine: symbol.startLine,
                endLine: symbol.endLine,
              });
            }

            // 保存風險
            for (const risk of result.risks) {
              await tx.insert(risks).values({
                projectId: projectId,
                riskType: risk.category as any,
                title: risk.title,
                description: risk.description,
                severity: risk.severity as any,
                sourceFile: risk.sourceFile,
                lineNumber: risk.lineNumber,
              });
            }

            // 更新專案狀態
            await tx
              .update(projects)
              .set({
                status: "completed",
                analysisProgress: 100,
              })
              .where(eq(projects.id, projectId));
          });

          return { success: true, riskScore: result.riskScore };
        } catch (error) {
          console.error("Analysis error:", error);
          throw new Error(`Analysis failed: ${error}`);
        }
      }),

    // 獲取分析結果
    getResult: protectedProcedure
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
    getRisks: protectedProcedure
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
    getSymbols: protectedProcedure
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

    // 下載報告
    downloadReport: protectedProcedure
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
  }),
});

export type AppRouter = typeof appRouter;
