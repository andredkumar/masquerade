/**
 * Round 2A — the TypeScript proposer reproduces the frozen Python spike (AUTOMASK_ROUND2A_PROPOSAL.md v2 §3).
 *
 *  1. constants: shared/automask/constants.ts (generated) equals shared/automask/constants.frozen.json (the spike's
 *     `--dump-constants` output on the freeze date) — key for key.
 *  2. the two synthetic, non-PHI fixtures in fixtures/automask/ (always run): same model / withheld / flag as the Python
 *     proposal.json, IoU ≥ 0.98 between the two rendered keep masks, depth within 2 px, conf within 0.02.
 *  3. the PHI fixtures (sandbox/bench/<clip>/{frame1.png, proposal.json}) when AUTOMASK_FIXTURES_DIR is set; skipped
 *     with a loud message otherwise (CI has no PHI).
 *
 * Run:  npx tsx server/services/__tests__/automask.fixture.test.ts
 *       AUTOMASK_FIXTURES_DIR=../sandbox/bench npx tsx server/services/__tests__/automask.fixture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { promises as fs, readFileSync } from 'fs';

import { AUTOMASK_CONSTANTS, RULES, CONSTANTS_FROZEN } from '../../../shared/automask/constants';
import { loadGray, compareToPython, listFixtures, fmtShape, type PyProposal } from '../../../scripts/automask_eval/lib';

const HERE = path.dirname(new URL(import.meta.url).pathname);

test('constants.ts matches the frozen Python dump key for key', () => {
  const frozen = JSON.parse(readFileSync(path.resolve(HERE, '../../../shared/automask/constants.frozen.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(CONSTANTS_FROZEN, frozen._frozen);
  const scalars = Object.keys(frozen).filter((k) => k !== 'RULES' && !k.startsWith('_'));
  for (const k of scalars) assert.deepEqual((AUTOMASK_CONSTANTS as Record<string, unknown>)[k], frozen[k], `constant ${k}`);
  assert.deepEqual(Object.keys(AUTOMASK_CONSTANTS).sort(), scalars.sort(), 'the generated file has exactly the dumped constants');
  assert.deepEqual({ ...RULES }, frozen.RULES, 'RULES toggles');
});

async function runFixtures(dir: string, label: string) {
  const fixtures = await listFixtures(dir);
  assert.ok(fixtures.length > 0, `${label}: no fixtures under ${dir}`);
  const failures: string[] = [];
  for (const f of fixtures) {
    const py: PyProposal = JSON.parse(await fs.readFile(f.proposal, 'utf8'));
    const r = compareToPython(f.clip, await loadGray(f.frame), py);
    if (!r.ok) failures.push(`${f.clip}: ${r.reasons.join('; ')} | py ${fmtShape(r.py_keep)} | ts ${fmtShape(r.ts_keep)}`);
    if (py.expected === 'withhold') assert.equal(r.ts_withheld, py.withheld, `${f.clip}: negative must withhold with the same reason`);
  }
  assert.deepEqual(failures, [], `${label}: ${failures.length}/${fixtures.length} fixtures outside tolerance`);
  return fixtures.length;
}

test('synthetic fixtures (in git) reproduce the Python proposals', async () => {
  const n = await runFixtures(path.resolve(HERE, 'fixtures/automask'), 'synthetic');
  assert.equal(n, 2);
});

test('PHI fixtures reproduce the Python proposals (AUTOMASK_FIXTURES_DIR)', async (t) => {
  const dir = process.env.AUTOMASK_FIXTURES_DIR;
  if (!dir) {
    t.diagnostic('AUTOMASK_FIXTURES_DIR is not set — the 51 PHI fixtures were NOT checked (set it to ../sandbox/bench on the sandbox Mac)');
    t.skip('AUTOMASK_FIXTURES_DIR unset');
    return;
  }
  const n = await runFixtures(path.resolve(dir), 'PHI');
  t.diagnostic(`${n} PHI fixtures within tolerance`);
});
