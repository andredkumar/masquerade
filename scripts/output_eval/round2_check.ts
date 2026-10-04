/**
 * Output Round 2 — the sandbox rows of docs/refactor/OUTPUT_ROUND2_SIGNOFF.md §4 that need the running server:
 *   backstop   crafted masks POSTed WITHOUT the client: a fully transparent PNG, a fully red PNG and a malformed data URL
 *              → 422 with the sign-off's message, one `apply.refused` line, the job row (psql) and GET /api/jobs/:id
 *              byte-identical before and after, nothing under spokes/template_mask/<job>/; the same three against the
 *              legacy POST /api/videos/:jobId/process; then a corrected mask applies on the same job.
 *   normal     a hand-drawn Remove and a hand-drawn Keep apply → one `apply.validate` each (dims_source frame0), no
 *              `apply.refused`.
 *   manifest   whole-job ZIP: every frames[].filename is a ZIP entry, the CSV `filename` column equals the manifest's,
 *              masquerade_version 1.1, the README sentence; run ZIP with and without base frames (a synthetic AI run
 *              written straight to the sandbox DB + spokes/ai/): same names, `images_included`, entries present iff
 *              included; a raw-input run names .png; a swept run falls back (raw → png, else the job's format).
 * Runs from the repo root against the sandbox server (scripts/sandbox/up.sh). No PHI leaves the sandbox; the synthetic
 * run's PNGs are 8 × 8 squares.
 *
 *   npx tsx scripts/output_eval/round2_check.ts --server http://localhost:5001 --clip "../sandbox/clips/ge_venue/Kidney_copy.mp4" \
 *       [--sections backstop,normal,manifest] [--out ../sandbox/results/<date>_output_round2.md]
 */
import path from 'path';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import Sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (k: string, d: string | null = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SERVER = opt('--server', 'http://localhost:5001')!;
const CLIP = opt('--clip', '../sandbox/clips/ge_venue/Kidney_copy.mp4')!;
const SECTIONS = opt('--sections', 'backstop,normal,manifest')!.split(',');
const OUT = opt('--out');
const PSQL = '/opt/homebrew/opt/postgresql@16/bin/psql';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: string[] = [];
let failures = 0;
const say = (s: string) => { console.log(s); out.push(s); };
const row = (ok: boolean, label: string, detail = '') => { if (!ok) failures++; say(`| ${ok ? '✅' : '❌'} | ${label} | ${detail} |`); };

const MSG = {
  nothing: "This mask doesn't remove anything. Draw over what should be removed, or switch to Keep and draw what should be kept.",
  everything: 'This mask removes the whole frame. Nothing would be left in the output.',
};

async function getJob(id: string) { return (await fetch(`${SERVER}/api/jobs/${id}`)).json(); }
function dbRow(id: string): string {
  return execFileSync(PSQL, ['-h', 'localhost', '-p', '5433', '-U', 'masq', '-d', 'masq', '-tAc', `select row_to_json(j)::text from jobs j where id='${id}'`]).toString().trim();
}
async function newestLog(): Promise<string> {
  const dir = path.resolve('..', 'sandbox', 'results');
  const files = (await fs.readdir(dir)).filter((f) => /^server_2.*\.log$/.test(f)).sort();
  return path.join(dir, files[files.length - 1]);
}
async function perfLines(jobId: string, stage: string): Promise<any[]> {
  const log = await fs.readFile(await newestLog(), 'utf8');
  return log.split('\n').filter((l) => l.startsWith('[PERF] ') && l.includes(`"jobId":"${jobId}"`) && l.includes(`"stage":"${stage}"`)).map((l) => JSON.parse(l.slice(7)));
}
async function waitReady(jobId: string) { for (let i = 0; i < 180; i++) { const j = await getJob(jobId); if (j.status === 'ready') return j; await sleep(1000); } throw new Error('not ready'); }
async function waitApplied(jobId: string, prev: string | null) {
  for (let i = 0; i < 240; i++) {
    const tm = (await getJob(jobId)).templateMask;
    if (tm?.status === 'complete' && tm.completedAt && tm.completedAt !== prev) return tm.completedAt as string;
    if (tm?.status === 'failed') throw new Error('apply failed');
    await sleep(500);
  }
  throw new Error('apply timeout');
}
async function upload(): Promise<string> {
  const fd = new FormData();
  fd.append('video', new Blob([await fs.readFile(CLIP)]), path.basename(CLIP));
  fd.append('phiStatus', 'raw');
  const r = await fetch(`${SERVER}/api/uploads/video`, { method: 'POST', body: fd });
  const j: any = await r.json();
  if (!j.jobId) throw new Error(`upload failed: ${JSON.stringify(j)}`);
  return j.jobId;
}

type Paint = (x: number, y: number) => boolean;   // true = red (blanked)
async function maskBody(w: number, h: number, paint: Paint | 'malformed', outputSettings: any = defaultSettings()) {
  let canvasDataUrl: string;
  if (paint === 'malformed') canvasDataUrl = 'not-a-data-url';
  else {
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (paint(x, y)) { const o = (y * w + x) * 4; rgba[o] = 255; rgba[o + 3] = 255; }
    const png = await Sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    canvasDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  }
  const maskData = {
    type: 'freeform', coordinates: [0, 0, w, h], opacity: 75, aspectRatioMode: 'letterbox', canvasWidth: w, canvasHeight: h, canvasDataUrl,
    originalCanvasDimensions: { width: w, height: h }, displayDimensions: { width: w, height: h }, devicePixelRatio: 1,
    aspectRatio: w / h, imageAspectRatio: w / h, imageDimensions: { width: w, height: h }, imageDisplayInfo: { scale: 1, offsetX: 0, offsetY: 0 },
  };
  return { maskData, outputSettings, samplingFps: null };
}
function defaultSettings() { return { size: 'original', format: 'jpg', includeMetadata: true, parallelThreads: 8, batchSize: 12, aspectRatioMode: 'letterbox' }; }
const post = (url: string, body: unknown) => fetch(`${SERVER}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function dirEntries(p: string): Promise<string[]> { try { return await fs.readdir(p); } catch { return []; } }
const zipNames = (zip: string) => execFileSync('unzip', ['-Z1', zip]).toString().split('\n').filter(Boolean);
const zipText = (zip: string, name: string) => execFileSync('unzip', ['-p', zip, name], { maxBuffer: 1 << 28 }).toString();
async function download(url: string, dest: string) { await fs.writeFile(dest, Buffer.from(await (await fetch(`${SERVER}${url}`)).arrayBuffer())); return dest; }

(async () => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const tmp = path.resolve('..', 'sandbox', 'results', `.round2_${stamp}`);
  await fs.mkdir(tmp, { recursive: true });
  const jobId = await upload();
  const job = await waitReady(jobId);
  const w = job.source.width as number, h = job.source.height as number;
  say(`### Output Round 2 sandbox rows — job ${jobId} (${path.basename(CLIP)}, ${w}×${h}, ${job.source.totalFrames} frames)\n`);
  say('| | row | detail |\n|---|---|---|');
  const spokeDir = path.resolve('spokes', 'template_mask', jobId);

  if (SECTIONS.includes('backstop')) {
    const crafted: Array<[string, Paint | 'malformed', 'nothing' | 'everything']> = [
      ['fully transparent PNG', () => false, 'nothing'],
      ['fully red PNG', () => true, 'everything'],
      ['malformed data URL', 'malformed', 'nothing'],
    ];
    for (const route of ['canonical', 'legacy'] as const) {
      for (const [name, paint, which] of crafted) {
        const before = { get: JSON.stringify(await getJob(jobId)), db: dbRow(jobId), files: await dirEntries(spokeDir) };
        const url = route === 'canonical' ? `/api/jobs/${jobId}/template-mask/apply` : `/api/videos/${jobId}/process`;
        const r = await post(url, await maskBody(w, h, paint));
        const body: any = await r.json().catch(() => ({}));
        await sleep(300);
        const after = { get: JSON.stringify(await getJob(jobId)), db: dbRow(jobId), files: await dirEntries(spokeDir) };
        const refused = (await perfLines(jobId, 'apply.refused')).filter((p) => p.reason === (which === 'nothing' ? 'mask_blanks_nothing' : 'mask_blanks_everything'));
        const wantMsg = which === 'nothing' ? MSG.nothing : MSG.everything;
        row(r.status === 422 && body.error === wantMsg && (route === 'legacy' || body.success === false),
          `${route}: ${name} → 422 ${which === 'nothing' ? 'mask_blanks_nothing' : 'mask_blanks_everything'}`, `status ${r.status}; body ${JSON.stringify(body).slice(0, 140)}`);
        row(before.get === after.get && before.db === after.db, `${route}: ${name} — job record unchanged`, `GET /api/jobs/:id equal, jobs row (${before.db.length} chars) equal`);
        row(after.files.length === 0 && before.files.length === 0, `${route}: ${name} — nothing under spokes/template_mask/<job>/`, `${after.files.length} entries`);
        row(refused.length >= 1, `${route}: ${name} — apply.refused logged`, refused.length ? JSON.stringify({ masked_px: refused.at(-1).masked_px, total_px: refused.at(-1).total_px, w: refused.at(-1).w, h: refused.at(-1).h }) : 'none');
      }
    }
    const validatesBefore = (await perfLines(jobId, 'apply.validate')).length;
    say(`\n_${validatesBefore} apply.validate lines so far — one per counted refusal (6)._\n`);
    // a corrected mask applies on the same job after the refusals
    const r = await post(`/api/jobs/${jobId}/template-mask/apply`, await maskBody(w, h, (x, y) => x >= 200 && x < 500 && y >= 100 && y < 300));
    row(r.status === 200, 'after the refusals, a corrected Remove mask applies on the same job', `status ${r.status}`);
    await waitApplied(jobId, null);
  }

  if (SECTIONS.includes('normal')) {
    let prev: string | null = (await getJob(jobId)).templateMask?.completedAt ?? null;
    const cases: Array<[string, Paint, number]> = [
      ['hand-drawn Remove (300 × 200)', (x, y) => x >= 200 && x < 500 && y >= 100 && y < 300, 300 * 200],
      ['hand-drawn Keep (600 × 500 kept)', (x, y) => !(x >= 660 && x < 1260 && y >= 240 && y < 740), w * h - 600 * 500],
    ];
    for (const [name, paint, expected] of cases) {
      const nV = (await perfLines(jobId, 'apply.validate')).length, nR = (await perfLines(jobId, 'apply.refused')).length;
      const r = await post(`/api/jobs/${jobId}/template-mask/apply`, await maskBody(w, h, paint));
      if (r.status === 200) prev = await waitApplied(jobId, prev);
      const v = (await perfLines(jobId, 'apply.validate')).slice(nV), rf = (await perfLines(jobId, 'apply.refused')).slice(nR);
      row(r.status === 200 && v.length === 1 && rf.length === 0 && v[0].dims_source === 'frame0' && v[0].masked_px === expected,
        `${name} proceeds`, `status ${r.status}; apply.validate ${JSON.stringify(v[0] ? { ms: v[0].ms, masked_px: v[0].masked_px, total_px: v[0].total_px, dims_source: v[0].dims_source } : null)}; refused ${rf.length}`);
    }
  }

  if (SECTIONS.includes('manifest')) {
    const stat = (await getJob(jobId)).templateMask?.status;
    if (stat !== 'complete') say(`_manifest rows need an applied job; templateMask.status is ${stat}_`);
    // whole-job ZIP
    const zip = await download(`/api/jobs/${jobId}/template-mask/download`, path.join(tmp, 'whole.zip'));
    const names = new Set(zipNames(zip));
    const man = JSON.parse(zipText(zip, 'manifest.json'));
    const csvRows = zipText(zip, 'metadata.csv').split('\n').slice(1).map((l) => l.split(',')[0]);
    row(man.masquerade_version === '1.1', 'whole-job: masquerade_version 1.1', String(man.masquerade_version));
    row(man.frames.length > 0 && man.frames.every((f: any) => names.has(f.filename)), 'whole-job: every frames[].filename is a ZIP entry', `${man.frames.length} frames; first ${man.frames[0]?.filename}`);
    row(JSON.stringify(csvRows) === JSON.stringify(man.frames.map((f: any) => f.filename)), 'whole-job: CSV filename column equals the manifest', `${csvRows.length} rows`);
    const imagesInZip = [...names].filter((n) => n.startsWith('images/') && !n.endsWith('/')).length;
    row(imagesInZip === man.frames.length, 'whole-job: images/ entry count equals frames[]', `${imagesInZip}`);
    row(zipText(zip, 'README.txt').includes('filename in manifest.json and metadata.csv is the path of that frame inside this ZIP.'), 'whole-job: README sentence', '');

    // synthetic AI runs written straight to the sandbox DB + spokes/ai/
    process.env.DATABASE_URL ??= 'postgresql://masq@localhost:5433/masq';
    const { storage } = await import('../../server/storage');
    const { aiRunDir } = await import('../../server/services/applyPaths');
    const tiny = await Sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const nFrames = man.frames.length;
    async function makeRun(inputSource: 'template_mask' | 'raw', jid = jobId, n = nFrames) {
      const runId = randomUUID();
      const dir = aiRunDir(jid, runId);
      await fs.mkdir(dir, { recursive: true });
      for (let i = 0; i < n; i++) { await fs.writeFile(path.join(dir, `mask_${i}.png`), tiny); await fs.writeFile(path.join(dir, `overlay_${i}.png`), tiny); }
      const label = { id: randomUUID(), intent: 'segment', target: 'synthetic', modality: null, confidence: 0.9, model: 'synthetic', timestamp: new Date().toISOString(), approved: true, bbox: null, frameResults: {} };
      await storage.addAiRun(jid, { id: runId, name: `synthetic ${inputSource}`, inputSource, modality: null, bbox: null, target: 'synthetic', outputDir: dir, labels: [label as any], approved: true, createdAt: new Date().toISOString() });
      return runId;
    }
    async function runZip(jid: string, runId: string, base: boolean, tag: string) {
      const z = await download(`/api/jobs/${jid}/ai/runs/${runId}/download${base ? '?includeBaseFrames=true' : ''}`, path.join(tmp, `${tag}.zip`));
      const entries = zipNames(z);
      return { man: JSON.parse(zipText(z, 'manifest.json')), entries, csv: zipText(z, 'metadata.csv').split('\n').slice(1).map((l) => l.split(',')[0]) };
    }
    for (const src of ['template_mask', 'raw'] as const) {
      const runId = await makeRun(src);
      const off = await runZip(jobId, runId, false, `${src}_off`);
      const on = await runZip(jobId, runId, true, `${src}_on`);
      const names1 = off.man.frames.map((f: any) => f.filename);
      const imgsOn = new Set(on.entries.filter((n) => n.startsWith('images/')));
      const imgsOff = off.entries.filter((n) => n.startsWith('images/') && !n.endsWith('/'));
      const ext = src === 'raw' ? 'png' : 'jpg';
      row(off.man.masquerade_version === '1.1' && on.man.masquerade_version === '1.1', `run (${src}): masquerade_version 1.1 with and without base frames`, `${off.man.masquerade_version} / ${on.man.masquerade_version}`);
      row(JSON.stringify(names1) === JSON.stringify(on.man.frames.map((f: any) => f.filename)) && JSON.stringify(off.csv) === JSON.stringify(names1), `run (${src}): same names with and without base frames; CSV equals manifest`, `${names1.length} names, e.g. ${names1[0]}`);
      row(names1.every((n: string) => n.endsWith(`.${ext}`)), `run (${src}): names end .${ext}`, '');
      row(off.man.images_included === false && imgsOff.length === 0, `run (${src}): without base frames → images_included false, no images/ entries`, `${imgsOff.length} entries`);
      row(on.man.images_included === true && names1.every((n: string) => imgsOn.has(n)), `run (${src}): with base frames → images_included true, every frames[].filename is a ZIP entry`, `${imgsOn.size} images`);
    }
    // swept: the frames are gone; the names still resolve by the fallback rule and images_included says false even when requested
    const sweptRawRun = await makeRun('raw');
    const sweptTmRun = await makeRun('template_mask');
    await fs.rm(path.resolve('temp_extracted', jobId), { recursive: true, force: true });
    await fs.rm(spokeDir, { recursive: true, force: true });
    for (const [rid, label, ext] of [[sweptRawRun, 'raw', 'png'], [sweptTmRun, 'template_mask', 'jpg']] as const) {
      const z = await runZip(jobId, rid, true, `swept_${label}`);
      row(z.man.images_included === false && z.man.frames.length === nFrames && z.man.frames.every((f: any) => f.filename.endsWith(`.${ext}`)),
        `run (${label}, frames swept, base frames requested): images_included false, names fall back to .${ext}`, `${z.man.frames[0]?.filename}; images/ entries ${z.entries.filter((n) => n.startsWith('images/')).length}`);
    }
  }

  say(`\n${failures ? `**${failures} FAILED**` : 'all rows passed'}`);
  if (OUT) await fs.writeFile(OUT, out.join('\n') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
