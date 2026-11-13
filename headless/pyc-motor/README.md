# pyc-motor

Entry point that exposes the scheduling core of Open Planner Studio — CPM (`solveProject`), resource
leveling (`levelResources`) and the P6 / MS Project / CSV readers and writers — behind a small,
plain-JSON model (`api.ts`). It only translates between that model and the app types; the engine and
adapters are used unchanged.

Build: `node scripts/build-pyc-motor.mjs` → `dist-pyc-motor/` (platform-neutral ESM: Node 22 and Web
Workers; no React, DOM, Tauri or app store). Type check: `npx tsc -p tsconfig.pyc-motor.json`.

License: LGPL-3.0-or-later, like the repository.
