import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../shared/schema';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Please set it in your .env file.\n' +
    'Example: DATABASE_URL=postgresql://user:password@host/dbname\n' +
    'You can get a free Postgres database at https://neon.tech'
  );
}

const sql = neon(process.env.DATABASE_URL);
export const db = drizzle(sql, { schema });
