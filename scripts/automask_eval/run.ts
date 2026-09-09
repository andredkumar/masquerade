/**
 * Round 2A — the D5 harness and the permanent tuning loop (AUTOMASK_ROUND2A_PROPOSAL.md v2 §4).
 *
 *   npx tsx scripts/automask_eval/run.ts --out ../sandbox/results/<date>_run1.md \
 *      [--bench ../sandbox/bench --refs ../sandbox/bench/reviews_freeze.json --split ../sandbox/split.json] \
 *      [--db $DATABASE_URL] [--server http://localhost:5001] [--fresh] [--log ../sandbox/results/server_*.log] \
 *      [--prev ../sandbox/results/<date>_run0.md] [--manifest ../sandbox/manifest.csv]
 *
 * Two independent modes, either or both:
 *  --bench   runs the TS proposer on every <bench>/<clip>/frame1.png and scores it against Andre's saved shape in
 *            reviews_freeze.json (absolute references) with the tuning passes' tolerant rule — one scale with tune.py
 *            (target on row A12: 39/50 with the reference-check clip excluded).
 *  --db      lists the sandbox jobs, fetches each job's proposal (the cached automask.json under the server's
 *            temp_extracted/, or GET --server …/proposal, with --fresh deleting the cache first), decodes the mask the
 *            user applied (mask_data.canvasDataUrl, red > 128 = blanked) and scores the proposal against it — what
 *            Apply actually did. Joins the manifest on the job's filename, falling back to (w, h, frames) with a warning.
 * --prev compares the tolerant status per clip/job with an earlier run's JSON and lists regressions (pass → fail, or
 * leak_core6 up by more than 0.5 pt). --log pulls the [PERF] automask.* ms out of server logs.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadGray, boundGrid, scoreShapes, keepRefFromMaskPng, fmtShape } from './lib';
import { propose } from '../../shared/automask/core';
import { renderKeepMask, score } from '../../shared/automask/render';
import { shapeDeltas } from '../../shared/automask/shape';
import type { KeepShape, Bound, ProposalJson } from '../../shared/automask/types';

const args = process.argv.slice(2);
const opt = (k: string, d: string | null = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k: string) => args.includes(k);
const outPath = opt('--out');
const TOL = { half: 1.5, apex: 8, top: 8, w_top: 8, depth: 12 };

interface Row { id: string; family?: string; vendor?: string; model: string | null; conf: number | null; iou: number | null; leak: number | null; over: number | null; leak6: number | null; over6: number | null; tolerant: boolean; controls_only: boolean; beyond: string[]; withheld: string | null; note?: string; ms?: number | null; d?: Record<string, number | null> | null;
  computed_by?: string | null; t0_from?: string | null; worker_ms?: number | null }   // 2B-1: ready- vs lazy-triggered, where the T0 box came from

function estimator(iou: number, leak6: number, tol: boolean, d: ReturnType<typeof shapeDeltas>, kindMatch: boolean): { controls_only: boolean; beyond: string[] } {
  const vals: Record<string, number | null> = d ? { half: d.d_half_angle_deg, apex: d.d_apex_px, top: d.d_arc_px, w_top: d.d_top_width_px, depth: d.d_depth_px } : {};
  const beyond = Object.keys(vals).filter((k) => vals[k] !== null && Math.abs(vals[k] as number) > (TOL as Record<string, number>)[k]);
  if (!kindMatch) beyond.unshift('model');
  return { controls_only: tol || (iou >= 0.8 && leak6 <= 0.01 && beyond.length === 1), beyond };
}

async function benchMode(): Promise<Row[]> {
  const benchDir = path.resolve(opt('--bench')!);
  const refs = JSON.parse(await fs.readFile(path.resolve(opt('--refs', path.join(benchDir, 'reviews_freeze.json'))!), 'utf8')) as Record<string, { shape_user?: KeepShape; verdict?: string; note?: string }>;
  const splitPath = opt('--split', path.join(benchDir, '..', 'split.json'))!;
  let split: { tune?: string[]; test?: string[]; family_of?: Record<string, string>; reference_check?: Record<string, string> } = {};
  try { split = JSON.parse(await fs.readFile(path.resolve(splitPath), 'utf8')); } catch { /* optional */ }
  const excluded = new Set(Object.keys(split.reference_check ?? {}));
  const rows: Row[] = [];
  for (const clip of Object.keys(refs).sort()) {
    const ref = refs[clip]?.shape_user;
    if (!ref) continue;
    const dir = path.join(benchDir, clip);
    let py: { bound: Bound | null; expected?: string; vendor?: string };
    try { py = JSON.parse(await fs.readFile(path.join(dir, 'proposal.json'), 'utf8')); } catch { continue; }
    const gray = await loadGray(path.join(dir, 'frame1.png'));
    const t0 = performance.now();
    const res = propose(gray, { bound: boundGrid(py.bound, gray.w, gray.h) });
    const ms = performance.now() - t0;
    if (!res.shape || res.withheld) { rows.push({ id: clip, family: split.family_of?.[clip], vendor: py.vendor, model: res.model, conf: res.conf, iou: null, leak: null, over: null, leak6: null, over6: null, tolerant: false, controls_only: false, beyond: ['withheld'], withheld: res.withheld, ms: Math.round(ms) }); continue; }
    const s = scoreShapes(res.shape, ref, gray.w, gray.h, py.bound);
    const d = shapeDeltas(res.shape, ref);
    const est = estimator(s.iou, s.leak_core6, s.tolerant, d, res.shape.kind === ref.kind);
    rows.push({ id: clip, family: split.family_of?.[clip], vendor: py.vendor, model: res.model, conf: Math.round(res.conf * 1e4) / 1e4, iou: s.iou, leak: s.leak, over: s.over_blank, leak6: s.leak_core6, over6: s.over_core6, tolerant: s.tolerant, ...est, withheld: null, ms: Math.round(ms),
      d: d ? { half: d.d_half_angle_deg, apex: d.d_apex_px, arc: d.d_arc_px, w_top: d.d_top_width_px, depth: d.d_depth_px } : null, note: excluded.has(clip) ? 'REFERENCE CHECK — excluded from counts' : (refs[clip].verdict ?? '') });
  }
  (rows as unknown as { _excluded: Set<string> })._excluded = excluded;
  return rows;
}

interface DbJob { id: string; filename: string | null; width: number | null; height: number | null; total_frames: number | null; mask_data: unknown; job_status: string | null; created_at: string | null }

async function dbMode(): Promise<Row[]> {
  const pgMod = (await import('pg')) as unknown as { Client?: new (o: { connectionString: string }) => import('pg').Client; default?: { Client: new (o: { connectionString: string }) => import('pg').Client } };
  const Client = pgMod.Client ?? pgMod.default!.Client;      // pg is CommonJS: under ESM interop the class sits on `default`
  const client = new Client({ connectionString: opt('--db')! });
  await client.connect();
  const q = await client.query<DbJob>('SELECT id, filename, width, height, total_frames, mask_data, job_status, created_at FROM jobs ORDER BY created_at DESC');
  await client.end();
  const server = opt('--server');
  const tempDir = path.resolve(opt('--temp-extracted', path.resolve(process.cwd(), 'temp_extracted'))!);
  const manifest = await loadManifest(opt('--manifest'));
  const rows: Row[] = [];
  for (const job of q.rows) {
    const cache = path.join(tempDir, job.id, 'automask.json');
    let prop: ProposalJson | null = null;
    if (has('--fresh')) { try { await fs.unlink(cache); } catch { /* none */ } }
    if (server) {
      try { const r = await fetch(`${server}/api/jobs/${job.id}/template-mask/proposal`); prop = r.ok ? (await r.json()) as ProposalJson : null; } catch (e) { console.warn(`GET proposal failed for ${job.id}: ${(e as Error).message}`); }
    } else {
      try { prop = JSON.parse(await fs.readFile(cache, 'utf8')); } catch { prop = null; }
    }
    const man = manifest.find((m) => m.filename === job.filename) ?? manifest.find((m) => m.w === job.width && m.h === job.height && m.frames === job.total_frames);
    if (man && man.filename !== job.filename) console.warn(`manifest join for ${job.id}: filename ${job.filename} not found, matched on (w,h,frames) → ${man.clip_id}`);
    const base: Row = { id: `${job.id.slice(0, 8)} ${job.filename ?? ''}`.trim(), family: man?.clip_id, vendor: man?.vendor, model: prop?.model ?? null, conf: prop?.confidence ?? null, iou: null, leak: null, over: null, leak6: null, over6: null,
      tolerant: false, controls_only: false, beyond: [], withheld: prop ? (prop.status === 'ready' ? null : (prop.withheld ?? (prop.reason ? `${prop.reason}` : `status ${prop.status}`))) : 'no proposal', ms: prop?.ms?.total ?? null,
      computed_by: prop?.computed_by ?? null, t0_from: (prop?.info?.t0_from as string | undefined) ?? null, worker_ms: prop?.ms?.worker ?? null,
      note: [prop?.grade, prop?.computed_by ? `by:${prop.computed_by}` : null, prop?.info?.t0_from ? `t0:${prop.info.t0_from}` : null].filter(Boolean).join(' · ') };
    const md = job.mask_data as { canvasDataUrl?: string } | null;
    if (!prop || prop.status !== 'ready' || !prop.keep || !md?.canvasDataUrl || !job.width || !job.height) { base.beyond = [prop && prop.status === 'ready' ? 'no applied mask' : 'no proposal']; rows.push(base); continue; }
    const png = Buffer.from(md.canvasDataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    let keepRef; try { keepRef = await keepRefFromMaskPng(png, job.width, job.height); } catch (e) { base.note = (e as Error).message; rows.push(base); continue; }
    const s = score(renderKeepMask(prop.keep, job.width, job.height, prop.bound, prop.margin_px), keepRef);
    const tol = s.iou >= 0.9 && s.leak_core6 <= 0.01;
    rows.push({ ...base, iou: s.iou, leak: s.leak, over: s.over_blank, leak6: s.leak_core6, over6: s.over_core6, tolerant: tol, controls_only: tol, beyond: tol ? [] : ['applied-mask reference: no parametric deltas'] });
  }
  return rows;
}

async function loadManifest(p: string | null) {
  if (!p) return [] as Array<{ clip_id: string; filename: string; vendor: string; w: number; h: number; frames: number }>;
  const text = await fs.readFile(path.resolve(p), 'utf8');
  const [head, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const cols = head.split(',');
  return lines.map((l) => { const c = l.split(','); const o: Record<string, string> = {}; cols.forEach((k, i) => (o[k] = c[i])); return { clip_id: o.clip_id, filename: path.basename(o.path ?? ''), vendor: o.vendor, w: +o.w, h: +o.h, frames: +o.frames }; });
}

function table(rows: Row[], title: string, excluded: Set<string> = new Set()): string {
  const f = (v: number | null | undefined, fmt = (x: number) => String(x)) => (v === null || v === undefined ? '—' : fmt(v));
  const L = [`### ${title}`, '', '| id | family / clip | model | conf | IoU | leak | over | leak_core6 | over_core6 | tolerant | controls-only (beyond) | Δ half / apex / arc / w_top / depth | ms | note |', '|' + '---|'.repeat(14)];
  for (const r of rows) {
    const d = r.d ? `${f(r.d.half, (x) => x.toFixed(1))} / ${f(r.d.apex, (x) => x.toFixed(0))} / ${f(r.d.arc, (x) => x.toFixed(0))} / ${f(r.d.w_top, (x) => x.toFixed(0))} / ${f(r.d.depth, (x) => x.toFixed(0))}` : '—';
    L.push(`| ${r.id} | ${r.family ?? ''} | ${r.model ?? '—'} | ${f(r.conf, (x) => x.toFixed(2))} | ${f(r.iou, (x) => x.toFixed(4))} | ${f(r.leak, (x) => x.toFixed(4))} | ${f(r.over, (x) => x.toFixed(4))} | ${f(r.leak6, (x) => x.toFixed(4))} | ${f(r.over6, (x) => x.toFixed(4))} | ${r.tolerant ? '✅' : r.withheld ? 'withheld: ' + r.withheld : '✗'} | ${r.controls_only ? '✅' : '✗'}${r.beyond.length ? ' (' + r.beyond.join(', ') + ')' : ''} | ${d} | ${f(r.ms)} | ${(r.note ?? '').replace(/\|/g, '/')} |`);
  }
  const counted = rows.filter((r) => !excluded.has(r.id));
  const tol = counted.filter((r) => r.tolerant).length, co = counted.filter((r) => r.controls_only).length, wh = counted.filter((r) => r.withheld && r.withheld !== 'no proposal').length;
  L.push('', `**tolerant (IoU ≥ 0.90 & leak_core6 ≤ 1 %): ${tol}/${counted.length}** · controls-only ${co}/${counted.length} · withheld ${wh}${excluded.size ? ` · excluded (reference check): ${[...excluded].join(', ')}` : ''}`);
  const worstLeak = counted.filter((r) => r.leak6 !== null).sort((a, b) => (b.leak6 ?? 0) - (a.leak6 ?? 0))[0];
  const worstOver = counted.filter((r) => r.over6 !== null).sort((a, b) => (b.over6 ?? 0) - (a.over6 ?? 0))[0];
  if (worstLeak) L.push(`worst leak_core6: ${worstLeak.id} ${worstLeak.leak6} · worst over_core6: ${worstOver?.id} ${worstOver?.over6}`);
  return L.join('\n');
}

function regressions(prev: Row[], cur: Row[]): string[] {
  const out: string[] = [];
  const pm = new Map(prev.map((r) => [r.id, r]));
  for (const r of cur) {
    const p = pm.get(r.id);
    if (!p) continue;
    if (p.tolerant && !r.tolerant) out.push(`${r.id}: tolerant → fail (IoU ${p.iou} → ${r.iou}, leak_core6 ${p.leak6} → ${r.leak6})`);
    else if (p.leak6 !== null && r.leak6 !== null && r.leak6 - p.leak6 > 0.005) out.push(`${r.id}: leak_core6 ${p.leak6} → ${r.leak6}`);
  }
  return out;
}

async function perfFromLogs(pattern: string | null): Promise<Record<string, number>> {
  if (!pattern) return {};
  const dir = path.dirname(path.resolve(pattern)), base = path.basename(pattern).replace(/\*/g, '.*');
  const files = (await fs.readdir(dir)).filter((f) => new RegExp('^' + base + '$').test(f));
  const out: Record<string, number> = {};
  for (const f of files) for (const line of (await fs.readFile(path.join(dir, f), 'utf8')).split('\n')) {
    const m = line.match(/\[PERF\] (\{.*\})/);
    if (!m) continue;
    try { const o = JSON.parse(m[1]); if (o.stage === 'automask.done') out[o.jobId] = o.ms_total; } catch { /* ignore */ }
  }
  return out;
}

async function main() {
  const sections: string[] = [`# automask eval — ${new Date().toISOString()}`, '', `args: ${args.join(' ')}`, ''];
  const json: Record<string, unknown> = { args, when: new Date().toISOString() };
  let all: Row[] = [];
  if (has('--bench')) {
    const rows = await benchMode();
    const excluded = (rows as unknown as { _excluded: Set<string> })._excluded ?? new Set<string>();
    sections.push(table(rows, `--bench: TS proposer vs Andre's frozen references (${path.basename(opt('--refs', 'reviews_freeze.json')!)})`, excluded));
    // per family
    const fams = new Map<string, Row[]>();
    for (const r of rows) if (!excluded.has(r.id)) { const k = r.family ?? '?'; if (!fams.has(k)) fams.set(k, []); fams.get(k)!.push(r); }
    sections.push('', '| family | n | tolerant | controls-only |', '|---|---|---|---|', ...[...fams.entries()].sort().map(([k, rs]) => `| ${k} | ${rs.length} | ${rs.filter((r) => r.tolerant).length}/${rs.length} | ${rs.filter((r) => r.controls_only).length}/${rs.length} |`));
    json.bench = rows; all = all.concat(rows);
  }
  if (has('--db')) {
    const rows = await dbMode();
    const perf = await perfFromLogs(opt('--log'));
    for (const r of rows) { const id = r.id.split(' ')[0]; const k = Object.keys(perf).find((j) => j.startsWith(id)); if (k) r.ms = perf[k]; }
    sections.push('', table(rows, '--db: proposals vs the masks the user applied (sandbox jobs)'));
    json.db = rows; all = all.concat(rows);
  }
  if (opt('--prev')) {
    let prev: { bench?: Row[]; db?: Row[] } = {};
    try { prev = JSON.parse(await fs.readFile(path.resolve(opt('--prev')!).replace(/\.md$/, '.json'), 'utf8')); } catch { sections.push('', `--prev: could not read ${opt('--prev')} (.json twin)`); }
    const regs = regressions([...(prev.bench ?? []), ...(prev.db ?? [])], all);
    sections.push('', `### regressions vs ${path.basename(opt('--prev')!)}`, '', regs.length ? regs.map((r) => `- ${r}`).join('\n') : '_none_');
    json.regressions = regs;
  }
  const md = sections.join('\n') + '\n';
  console.log(md);
  if (outPath) { await fs.writeFile(path.resolve(outPath), md); await fs.writeFile(path.resolve(outPath).replace(/\.md$/, '.json'), JSON.stringify(json, null, 1)); console.log(`wrote ${outPath} (+ .json)`); }
}

main().catch((e) => { console.error(e); process.exit(2); });
