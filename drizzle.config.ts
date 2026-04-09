import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` only needs the schema file, but `migrate` still needs a real DATABASE_URL.
// Use a placeholder so local generation remains possible without a live database connection.
const connectionString = process.env.DATABASE_URL ?? "mysql://root:root@127.0.0.1:3306/plateaubreaker";

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: connectionString,
  },
});
