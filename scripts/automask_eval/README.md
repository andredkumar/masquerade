# automask_eval — Round 2A harness

Scripts around the TypeScript proposer in `shared/automask/` (the port of the frozen Python spike in
`scripts/automask_spike/`, constants frozen 2026-09-06). Everything here is Node-only tooling; nothing under
`client/` imports it.

| script | what |
|---|---|
| `gen-constants.ts <dump.json>` | writes `shared/automask/constants.ts` from `python3 scripts/automask_spike/automask_spike.py --dump-constants`. Also refresh `shared/automask/constants.frozen.json` from the same dump; the fixture test compares the two. |
| `make-synthetic.ts` | renders the two non-PHI fixtures in `server/services/__tests__/fixtures/automask/` (a fan with header text, glyph and ruler; a trapezoid with a T0 bound, label, greyscale bar, echo-free corners). Their expected `proposal.json` is produced by the **Python** spike: `automask_spike.py --propose-png <png> [--bound x0,y0,x1,y1]`. |
| `compare-fixtures.ts [--dir ../sandbox/bench]` | runs the TS proposer on every `<dir>/<clip>/{frame1.png,proposal.json}` and compares with the Python proposal (model, withheld, IoU ≥ 0.98, depth ≤ 2 px, conf ≤ 0.02). The PHI fixtures live in the sandbox only. |
| `run.ts` | the eval: `--bench` scores the TS proposer against Andre's frozen references (`reviews_freeze.json`) on the tuning passes' tolerant rule (target 39/50, reference-check clip excluded); `--db $DATABASE_URL [--server URL] [--fresh]` scores each sandbox job's proposal against the mask the user applied; `--prev` lists regressions; `--log` pulls `[PERF] automask.*` timings. Writes `--out <file>.md` and a `.json` twin (the `--prev` input). |
| `lib.ts` | shared helpers (decode → spike grayscale, bound grid, Python comparison, scoring, mask-PNG → keep_ref). |

Tests: `npx tsx server/services/__tests__/automask.fixture.test.ts` (constants + synthetic; add
`AUTOMASK_FIXTURES_DIR=../sandbox/bench` for the PHI fixtures) and `npx tsx server/services/__tests__/automask.endpoint.test.ts`
(service contract with mocked storage; no DB).

Sandbox flow (D5): `AUTOMASK=1 PORT=5001 zsh scripts/sandbox/up.sh`, upload the kickoff clips, draw and Apply, then
`npx tsx scripts/automask_eval/run.ts --db "$DATABASE_URL" --server http://localhost:5001 --manifest ../sandbox/manifest.csv --log '../sandbox/results/server_*.log' --bench ../sandbox/bench --out ../sandbox/results/<date>_eval.md`.
The cache invalidation rule is the file: delete `temp_extracted/<jobId>/automask.json` (or pass `--fresh`) to re-propose.
