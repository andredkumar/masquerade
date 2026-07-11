import { defineConfig } from "drizzle-kit";
// Same SSL gating as server/db.ts. Without this, `db:migrate` connected to Aurora
// unencrypted and was rejected (`no pg_hba.conf entry … no encryption`, 28000).
import { resolveSsl } from "./server/dbSsl";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
    ssl: resolveSsl(process.env.DATABASE_URL),
  },
});
