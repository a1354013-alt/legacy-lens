import { eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: mysql.Pool | null = null;

// Configuration constants moved from hardcoded values
const DB_CONFIG = {
  connectionLimit: Number.parseInt(process.env.DB_CONNECTION_LIMIT || "10", 10),
  queueLimit: Number.parseInt(process.env.DB_QUEUE_LIMIT || "0", 10),
  acquireTimeoutMs: Number.parseInt(process.env.DB_ACQUIRE_TIMEOUT_MS || "60000", 10),
  waitForConnections: process.env.DB_WAIT_FOR_CONNECTIONS !== "false",
} as const;

export async function validateDbConfig() {
  if (!ENV.databaseUrl) {
    throw new Error("[Database] DATABASE_URL is required before the server can start.");
  }

  return true;
}

/**
 * Get or create database connection pool
 * Configured for production with connection pooling
 */
export async function getPool(): Promise<mysql.Pool> {
  if (_pool) {
    return _pool;
  }

  if (!ENV.databaseUrl) {
    throw new Error("[Database] DATABASE_URL is not configured");
  }

  _pool = mysql.createPool({
    uri: ENV.databaseUrl,
    connectionLimit: DB_CONFIG.connectionLimit,
    queueLimit: DB_CONFIG.queueLimit,
    acquireTimeout: DB_CONFIG.acquireTimeoutMs,
    waitForConnections: DB_CONFIG.waitForConnections,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });

  // Test connection
  try {
    const connection = await _pool.getConnection();
    await connection.ping();
    connection.release();
    console.log("[Database] Connection pool established successfully");
  } catch (error) {
    console.error("[Database] Failed to establish connection pool:", error);
    throw error;
  }

  return _pool;
}

export async function getDb() {
  if (_db) {
    return _db;
  }

  if (!ENV.databaseUrl) {
    return null;
  }

  const pool = await getPool();
  _db = drizzle(pool);
  return _db;
}

/**
 * Close database connection pool gracefully
 * Call this during application shutdown
 */
export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
  if (_db) {
    _db = null;
  }
  console.log("[Database] Connection pool closed");
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    throw new Error("[Database] Cannot upsert user because the database is unavailable.");
  }

  const values: InsertUser = {
    openId: user.openId,
  };
  const updateSet: Record<string, unknown> = {};

  const textFields = ["name", "email", "loginMethod"] as const;
  type TextField = (typeof textFields)[number];

  const assignNullable = (field: TextField) => {
    const value = user[field];
    if (value === undefined) return;
    const normalized = value ?? null;
    values[field] = normalized;
    updateSet[field] = normalized;
  };

  textFields.forEach(assignNullable);

  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }

  if (!values.lastSignedIn) {
    values.lastSignedIn = new Date();
  }

  if (Object.keys(updateSet).length === 0) {
    updateSet.lastSignedIn = new Date();
  }

  await db.insert(users).values(values).onDuplicateKeyUpdate({
    set: updateSet,
  });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}
