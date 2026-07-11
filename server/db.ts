// `pg` is CommonJS: a named `import { Pool } from 'pg'` resolves to no runtime
// export under this project's ESM/tsx setup ("does not provide an export named
// 'Pool'"). Default-import the module and destructure the value.
import pg from 'pg';
const { Pool } = pg;
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../shared/schema';
// SSL gating lives in one shared module so this Pool and drizzle.config.ts's
// migrate connection make the identical SSL decision (Phase 5C-1). See dbSsl.ts.
import { resolveSsl } from './dbSsl';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Please set it in your .env file.\n' +
    'Example: DATABASE_URL=postgresql://user:password@host:5432/dbname'
  );
}

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({ connectionString, ssl: resolveSsl(connectionString) });
export const db = drizzle(pool, { schema });
