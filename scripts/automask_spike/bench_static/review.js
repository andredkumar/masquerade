/* Track 0 review page logic (tuning pass 1: full-parametric controls — addendum §2).
   Expects window.PROPOSAL (proposal.json) and AutomaskShape (shape.js). */
(function () {
  'use strict';
  const P = window.PROPOSAL;
  const S = window.AutomaskShape;
  // a page generated before this bench version lacks the stamp element: say so loudly rather than fail silently
  if (!document.getElementById('stamp')) { const h = document.querySelector('header'); if (h) { const b = document.createElement('span'); b.className = 'stamp'; b.textContent = 'STALE PAGE — run bench.py --pages and reload'; h.append(b); } }
  const img = document.getElementById('frame');
  const cv = document.getElementById('layer');
  const ctx = cv.getContext('2d');
  const ctrlBox = document.getElementById('controls');
  const verdictBtns = Array.from(document.querySelectorAll('[data-verdict]'));
  const note = document.getElementById('note');
  const saveBtn = document.getElementById('save');
  const status = document.getElementById('status');
  const showMask = document.getElementById('showMask');
  const fit = P.keep ? Object.assign({}, P.keep) : null;
  let shape = fit ? Object.assign({}, fit) : null;
  let verdict = null;
  const ctrls = shape ? S.controls(shape, P.w, P.h, P.bound) : [];
  const inputs = {};

  function fitToPane() {
    const maxW = Math.min(window.innerWidth - 400, 1100);
    const sc = Math.min(1, maxW / P.w, (window.innerHeight - 140) / P.h);
    img.style.width = cv.style.width = Math.round(P.w * sc) + 'px';
    img.style.height = cv.style.height = Math.round(P.h * sc) + 'px';
  }

  function fmtDelta(c, v) {
    const d = v - c.fitted;
    if (c.unit === 'deg') return (d >= 0 ? '+' : '') + (d * S.DEG).toFixed(1) + '°';
    return (d >= 0 ? '+' : '') + Math.round(d) + ' px';
  }

  function redraw() {
    ctx.clearRect(0, 0, P.w, P.h);
    if (!shape) return;
    if (showMask.checked) S.drawMaskRaster(ctx, P.w, P.h, shape, P.bound, P.margin_px || 0);
    else S.drawProposalLayer(ctx, P.w, P.h, shape, P.bound);
    let changed = false;
    for (const c of ctrls) {
      const v = valueOf(c); const el = inputs[c.key + ':' + c.role];
      if (el) { el.readout.textContent = `${c.display(c.fitted, P.shape_fit || null)} → ${c.display(v, shape)}  (${fmtDelta(c, v)})`; if (el.input && el.input.type === 'range') el.input.value = v; }
      if (Math.abs(v - c.fitted) > 1e-9) changed = true;
    }
    if (changed && verdict === null) setVerdict('adjusted', true);
    const t2 = document.getElementById('t2extLabel');
    if (t2 && P.t2ext && P.t2ext.value != null) t2.textContent = `T2ext (max-projection) suggests depth ${Math.round(P.t2ext.value)} (Δ ${P.t2ext.delta >= 0 ? '+' : ''}${Math.round(P.t2ext.delta)} px)`;
  }

  function valueOf(c) {
    if (c.key === 'side_angle') return S.trapSideAngle(shape);
    if (c.key === 'top_width_arc') return 2 * shape.r_in * Math.sin(shape.half_angle);
    return shape[c.key];
  }

  function setVerdict(v, soft) {
    verdict = v;
    verdictBtns.forEach(b => b.classList.toggle('on', b.dataset.verdict === v));
    if (!soft) status.textContent = '';
  }

  function apply(c, v) { shape = S.withParam(shape, c.key, v); redraw(); }

  function buildControls() {
    ctrlBox.innerHTML = '';
    const byRole = r => ctrls.find(c => c.role === r);
    // angle / width slider
    const rows = [byRole('angle'), byRole('topwidth'), byRole('top'), byRole('depth')].filter(Boolean);
    for (const c of rows) {
      const row = document.createElement('div'); row.className = 'ctl';
      const lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = c.label;
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = c.min; inp.max = c.max; inp.step = c.step; inp.value = c.fitted;
      inp.addEventListener('input', () => apply(c, Number(inp.value)));
      const ro = document.createElement('div'); ro.className = 'muted mono';
      row.append(lab, inp, ro); ctrlBox.append(row);
      inputs[c.key + ':' + c.role] = { input: inp, readout: ro };
    }
    // apex / axis nudge
    const nx = byRole('nudge_x'), ny = byRole('nudge_y');
    if (nx || ny) {
      const row = document.createElement('div'); row.className = 'ctl';
      const lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = (shape.kind === 'fan' ? 'apex' : 'axis / top') + ' nudge (2 px)';
      const pad = document.createElement('div'); pad.className = 'row';
      const mk = (txt, c, d) => { const b = document.createElement('button'); b.textContent = txt; b.disabled = !c; if (c) b.addEventListener('click', () => apply(c, valueOf(c) + d * c.step)); return b; };
      pad.append(mk('←', nx, -1), mk('→', nx, +1), mk('↑', ny, -1), mk('↓', ny, +1));
      const ro = document.createElement('div'); ro.className = 'muted mono';
      row.append(lab, pad, ro); ctrlBox.append(row);
      if (nx) inputs[nx.key + ':' + nx.role] = { input: null, readout: ro };
      if (ny) { const ro2 = document.createElement('div'); ro2.className = 'muted mono'; row.append(ro2); inputs[ny.key + ':' + ny.role] = { input: null, readout: ro2 }; }
    }
    const foot = document.createElement('div'); foot.className = 'row';
    const reset = document.createElement('button'); reset.textContent = 'Reset to fit'; reset.addEventListener('click', () => { shape = Object.assign({}, fit); redraw(); });
    const useT2 = document.createElement('button'); useT2.textContent = 'Use T2ext depth'; const dc = byRole('depth');
    if (P.t2ext && P.t2ext.value != null && dc) useT2.addEventListener('click', () => apply(dc, P.t2ext.value)); else useT2.disabled = true;
    foot.append(reset, useT2); ctrlBox.append(foot);
    const t2l = document.createElement('div'); t2l.id = 't2extLabel'; t2l.className = 'muted'; ctrlBox.append(t2l);
    const help = document.createElement('div'); help.className = 'muted';
    help.textContent = shape.kind === 'fan' ? 'Top width (arc stays): widens or narrows the cone at the top while the inner arc and the bottom width stay put (apex and half-angle move together). Half-angle: both sides about the vertical axis, apex fixed. Drag the yellow apex dot (or shift-drag anywhere) to move the apex. Arrow keys: depth ±1 px (shift ±10). A/D: half-angle ±0.5°.'
      : 'Side angle pivots both sides about the top corners. Drag the top-edge midpoint (or shift-drag anywhere) to move axis/top. Arrow keys: depth ±1 px (shift ±10). A/D: side angle ±0.5°.';
    ctrlBox.append(help);
  }

  cv.width = P.w; cv.height = P.h;
  fitToPane(); window.addEventListener('resize', fitToPane);

  if (shape) {
    buildControls();
    window.addEventListener('keydown', e => {
      if (e.target === note) return;
      const dc = ctrls.find(c => c.role === 'depth'), ac = ctrls.find(c => c.role === 'angle' && c.unit === 'deg');
      const step = e.shiftKey ? 10 : 1;
      if (dc && (e.key === 'ArrowRight' || e.key === 'ArrowUp')) { apply(dc, Math.min(dc.max, valueOf(dc) + step)); e.preventDefault(); }
      if (dc && (e.key === 'ArrowLeft' || e.key === 'ArrowDown')) { apply(dc, Math.max(dc.min, valueOf(dc) - step)); e.preventDefault(); }
      if (ac && (e.key === 'd' || e.key === 'D')) apply(ac, valueOf(ac) + 0.5 / S.DEG);
      if (ac && (e.key === 'a' || e.key === 'A')) apply(ac, valueOf(ac) - 0.5 / S.DEG);
    });
  } else {
    document.getElementById('ctlBox').hidden = true;
  }
  showMask.addEventListener('change', redraw);
  img.addEventListener('load', redraw); if (img.complete) redraw();

  // Drag handle (addendum §2): drag the apex (fan) or the top-edge midpoint (trapezoid / rectangle).
  // Canvas pixels = frame pixels; the element is CSS-scaled, so convert through the bounding rect.
  let drag = null;
  const toCanvas = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * P.w / r.width, (e.clientY - r.top) * P.h / r.height]; };
  const handlePos = () => shape ? (shape.kind === 'fan' ? [shape.ax, shape.ay] : [shape.cx, shape.y_top]) : null;
  cv.addEventListener('pointerdown', e => {
    const hp = handlePos(); if (!hp) return;
    const [x, y] = toCanvas(e);
    const tol = 18 * P.w / cv.getBoundingClientRect().width;
    if (Math.hypot(x - hp[0], y - hp[1]) <= tol || e.shiftKey) { drag = { x0: x, y0: y, s0: Object.assign({}, shape) }; cv.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const [x, y] = toCanvas(e); const dx = x - drag.x0, dy = y - drag.y0;
    if (shape.kind === 'fan') { shape = S.withParam(S.withParam(drag.s0, 'ax', drag.s0.ax + dx), 'ay', drag.s0.ay + dy); }
    else { shape = S.withParam(S.withParam(drag.s0, 'cx', drag.s0.cx + dx), 'y_top', drag.s0.y_top + dy); }
    redraw();
  });
  const endDrag = e => { if (drag) { drag = null; try { cv.releasePointerCapture(e.pointerId); } catch (_) {} } };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
  cv.style.touchAction = 'none';

  verdictBtns.forEach(b => b.addEventListener('click', () => setVerdict(b.dataset.verdict)));

  saveBtn.addEventListener('click', async () => {
    if (!verdict) { status.textContent = 'Pick a verdict first.'; return; }
    const d = shape ? S.deltas(fit, shape) : null;
    const body = {
      clip_id: P.clip_id, verdict, note: note.value || '', reference: 'full-parametric', bench_version: window.BENCH_VERSION || null,
      tier: P.tier, model: P.model, conf: P.conf, expected: P.expected,
      shape_fit: fit, shape_user: shape, deltas: d,
      // depth-only fields kept for continuity with the first review's columns
      depth_key: shape ? (shape.kind === 'fan' ? 'r_out' : 'y_bottom') : null,
      depth_fit: fit ? (fit.kind === 'fan' ? fit.r_out : fit.y_bottom) : null,
      depth_user: shape ? (shape.kind === 'fan' ? shape.r_out : shape.y_bottom) : null,
      delta_px: d ? Math.round(d.d_depth_px) : null,
      t2ext_delta: P.t2ext ? P.t2ext.delta : null,
      ts: new Date().toISOString(),
    };
    // loud client-side validation (pass-2 prep §1): a stale page cannot silently save a depth-only review
    const needShape = !['withheld_ok', 'withheld_miss'].includes(verdict);
    if (needShape && (!body.shape_user || !d || !('d_half_angle_deg' in d) || !('d_depth_px' in d) || !S.controls)) {
      status.textContent = 'NOT saved: this page is missing the full-parametric controls — hard-reload (⌘⇧R). Expected ' + (window.BENCH_VERSION || 'bench v3'); return;
    }
    try {
      const r = await fetch('/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      status.textContent = r.ok ? `Saved ✓  (${body.verdict}${d ? `, Δangle ${(d.d_half_angle_deg || 0).toFixed(1)}°, Δtop width ${Math.round(d.d_top_width_px || 0)} px, Δdepth ${Math.round(d.d_depth_px)} px` : ''})` : 'NOT saved: ' + (j.error || ('HTTP ' + r.status));
    } catch (e) { status.textContent = 'NOT saved (is bench.py --serve running?)'; }
  });

  // numeric shape comparison (JSON.stringify would call 160 !== 160.0 different on other paths)
  const sameShape = (a, b) => { if (!a || !b || a.kind !== b.kind) return false; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (k === 'sym') continue; const va = a[k], vb = b[k]; if (typeof va === 'number' && typeof vb === 'number') { if (Math.abs(va - vb) > 1e-6 * Math.max(1, Math.abs(va))) return false; } else if (JSON.stringify(va) !== JSON.stringify(vb)) return false; } return true; };
  fetch('/reviews.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}).then(all => {
    const prev = all && all[P.clip_id];
    if (!prev) return;
    const pn = document.getElementById('prevNote');
    if (prev.note) { if (pn) pn.textContent = `previous note (${(prev.ts || '').slice(0, 16)}): “${prev.note}”`; if (!note.value) note.value = prev.note; }
    if (prev.reference !== 'full-parametric' || !prev.shape_user || !sameShape(prev.shape_fit, fit)) {
      status.textContent = `A previous review exists (${prev.ts}) but the fit has changed since — please review again (your note is kept below).`; return;
    }
    setVerdict(prev.verdict, true);
    if (shape) { shape = Object.assign({}, prev.shape_user); redraw(); }
    status.textContent = `Previous review loaded (${prev.ts}).`;
  }).catch(() => {});
})();
