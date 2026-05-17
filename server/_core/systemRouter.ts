import { users } from "../../drizzle/schema";
import { getDb } from "../db";
import { publicProcedure, router } from "./trpc";
import { getAppVersion, getCommitHash } from "./version";

export const systemRouter = router({
  health: publicProcedure.query(async () => {
    let dbStatus = "unknown";

    try {
      const db = await getDb();

      if (!db) {
        dbStatus = "disconnected";
      } else {
        await db.select().from(users).limit(1);
        dbStatus = "connected";
      }
    } catch {
      dbStatus = "disconnected";
    }

    return {
      ok: true,
      timestamp: new Date().toISOString(),
      version: getAppVersion(),
      commitHash: getCommitHash(),
      dbStatus,
      environment: process.env.NODE_ENV ?? "development",
    };
  }),
});
