/**
 * Single source of truth for Postgres SSL gating (Phase 5C-1).
 *
 * There are TWO independent places that open a Postgres connection, and BOTH
 * must make the same SSL decision or they hit the DB differently:
 *   • server/db.ts        — the `pg` Pool used by the app + the conformance harness.
 *   • drizzle.config.ts   — the connection drizzle-kit uses for `db:migrate`.
 * The first real-RDS run failed because only db.ts carried SSL; drizzle.config.ts
 * passed a bare `url`, so `db:migrate` went out unencrypted and Aurora rejected it
 * with `no pg_hba.conf entry … no encryption` (SQLSTATE 28000). Both now import
 * THIS function so the SSL posture is identical on every path.
 *
 * Rule: enable SSL when the target needs it, detected by:
 *   • an RDS/Aurora host (contains `rds.amazonaws.com`), or
 *   • an explicit `sslmode` in the URL (anything but `disable`).
 * A plain local/dev Postgres (non-RDS host, no `sslmode`) stays SSL-off — that
 * setup is not part of 5C-1 testing but must keep working unchanged.
 *
 * `rejectUnauthorized: false` accepts RDS's server certificate WITHOUT CA
 * verification — a deliberate disposable-test-DB choice (the harness proves
 * derivation logic, not TLS hardening). 5C-2 (production / PHI): revisit to
 * `rejectUnauthorized: true` with the RDS CA bundle. No secret lives here —
 * credentials come only from the connection string in env.
 */
export function resolveSsl(url: string): { rejectUnauthorized: false } | undefined {
  let host = '';
  let sslmode = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    sslmode = parsed.searchParams.get('sslmode') ?? '';
  } catch {
    // Unparseable URL: leave SSL off and let the driver surface the connection error.
  }
  const needsSsl =
    host.includes('rds.amazonaws.com') ||
    (sslmode !== '' && sslmode !== 'disable');
  return needsSsl ? { rejectUnauthorized: false } : undefined;
}
