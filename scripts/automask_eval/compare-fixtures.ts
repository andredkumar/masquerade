/**
 * Round 2A — does the TypeScript core reproduce the frozen Python spike?
 *
 *   npx tsx scripts/automask_eval/compare-fixtures.ts [--dir ../sandbox/bench] [--clips a,b] [--json out.json]
 *
 * For every <dir>/<clip>/{frame1.png|frame.png, proposal.json} (the fixtures the frozen spike wrote): decode the frame,
 * build the T0 bound from proposal.json, run `propose()`, compare with the Python result — model, withheld/flag, IoU of
 * the two full-resolution keep masks (both rendered by the TS renderer from their parameters, bound + margin applied),
 * |Δ r_out| (fan) / |Δ y_bottom| (trap, rect), |Δ conf|. Assertions (AUTOMASK_ROUND2A_PROPOSAL.md §3): same
 * model/withheld/flag, IoU ≥ 0.98, depth within 2 px, conf within 0.02. The same comparison runs inside
 * server/services/__tests__/automask.fixture.test.ts. PHI fixtures never enter git; this script only reads them.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadGray, compareToPython, listFixtures, fmtShape, type PyProposal } from './lib';

const args = process.argv.slice(2);
const opt = (k: string, d: string | null = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = path.resolve(opt('--dir', opt('--bench', path.resolve(process.cwd(), '../sandbox/bench')))!);
const only = opt('--clips')?.split(',').filter(Boolean);
const jsonOut = opt('--json');

async function main() {
  const fixtures = (await listFixtures(dir)).filter((f) => !only || only.includes(f.clip));
  const rows = [];
  let pass = 0;
  for (const f of fixtures) {
    const py: PyProposal = JSON.parse(await fs.readFile(f.proposal, 'utf8'));
    const gray = await loadGray(f.frame);
    const r = compareToPython(f.clip, gray, py);
    rows.push({ ...r, expected: py.expected });
    if (r.ok) pass++;
    console.log(`${r.ok ? '✅' : '✗ '} ${f.clip.padEnd(26)} ${String(r.py_model).padEnd(8)}→${String(r.ts_model).padEnd(8)} ${r.py_withheld ? 'withheld:' + r.py_withheld + '→' + r.ts_withheld + ' ' : ''}IoU=${r.iou ?? '—'} Δdepth=${r.d_depth ?? '—'} Δconf=${r.d_conf ?? '—'} ${r.ms} ms`);
    if (!r.ok) console.log(`      ${r.reasons.join('; ')}\n      py: ${fmtShape(r.py_keep)}\n      ts: ${fmtShape(r.ts_keep)}   rules=${JSON.stringify(r.rules)}`);
  }
  console.log(`\n${pass}/${fixtures.length} fixtures within tolerance (model/withheld/flag equal, IoU ≥ 0.98, |Δdepth| ≤ 2 px, |Δconf| ≤ 0.02)`);
  if (jsonOut) await fs.writeFile(jsonOut, JSON.stringify({ pass, n: fixtures.length, rows }, null, 1));
  process.exitCode = pass === fixtures.length ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(2); });
