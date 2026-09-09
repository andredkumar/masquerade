// Auto-mask 2B-1 — dev/test bootstrap for the proposer worker (AUTOMASK_ROUND2B_RECON_PROPOSAL.md §1.1).
// A worker thread does not inherit the parent's tsx loader (`execArgv: ['--import','tsx']` was tested and fails on
// the first extensionless import in shared/automask), so register tsx inside the thread, then load the .ts entry.
// Never used by the production bundle: automaskWorkerClient resolves dist/automaskWorker.js there.
import { register } from 'tsx/esm/api';
register();
await import('./automaskWorker.ts');
