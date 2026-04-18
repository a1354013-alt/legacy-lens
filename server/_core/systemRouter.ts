import { z } from "zod";
import { db } from "../db";
import { notifyOwner } from "./notification";
import { adminProcedure, publicProcedure, router } from "./trpc";

export const systemRouter = router({
  health: publicProcedure.query(async () => {
    let dbStatus = "unknown";
    try {
      await db.select().from(db.schema.users).limit(1);
      dbStatus = "connected";
    } catch {
      dbStatus = "disconnected";
    }

    return {
      ok: true,
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      dbStatus,
      environment: process.env.NODE_ENV ?? "development",
    };
  }),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),
});
