// Phase 7A-5 — ambient declaration for `dcmjs` (ships no type definitions and has
// no @types package). Resolves TS7016 on `import * as dcmjs from 'dcmjs'` in
// frameExtractor.ts without changing runtime behavior. `any`-typed by design; if a
// typed API surface is ever needed, replace this with real declarations.
declare module 'dcmjs';
