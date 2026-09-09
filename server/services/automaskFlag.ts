/**
 * Auto-mask feature flag (Round 2A; split out in 2B-1 so the T0 capture module can read it without importing the
 * service — automask.ts imports automaskT0.ts, and a module cycle there would be a trap for the next reader).
 *
 * `AUTOMASK` reaches the process only through pm2's environment on prod (`AUTOMASK=1 pm2 restart masquerade
 * --update-env && pm2 save`); there is no dotenv in this project. Off (unset / 0 / anything else) = 2A/2B-1 do nothing.
 */
export const AUTOMASK_FLAG_ENV = 'AUTOMASK';

export function automaskEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(env[AUTOMASK_FLAG_ENV] ?? '');
}
