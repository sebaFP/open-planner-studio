# pyc-motor

Entry point that exposes the scheduling core of Open Planner Studio — CPM (`solveProject`), resource
leveling (`levelResources`) and the P6 / MS Project / CSV readers and writers — behind a small,
plain-JSON model (`api.ts`). It only translates between that model and the app types; the engine and
adapters are used unchanged.

Build: `node scripts/build-pyc-motor.mjs` → `dist-pyc-motor/` (platform-neutral ESM: Node 22 and Web
Workers; no React, DOM, Tauri or app store). Type check: `npx tsc -p tsconfig.pyc-motor.json`.

License: LGPL-3.0-or-later, like the repository.

## Behaviour notes

- **Milestones** (`tipo: 'hito'`): one that receives an FS or FF relation sits on the predecessor's finish
  instant (5x8: Friday stays Friday, not the next Monday) and shows `inicio = fin` on that day. One with no
  incoming FS/FF is a start milestone on its own day. A milestone read from a file keeps its own kind.
- **`restriccion` MSO / MFO** are hard pins in every profile: the date wins over the logic and a relation
  it breaks stays reported (`restriccionesVioladas`, negative float on the predecessor). A pin pushed past its
  date by the status date is reported too.
- **`nivelar`** never moves a MSO/MFO task (it books as fixed load; two pins that collide are listed in
  `sinResolver`). When several tasks could wait it prefers the one that does not break its own
  SNLT/FNLT/`fechaLimite`. Result field `avisos: { tareaId, tipo: 'restriccion' | 'fechaLimite' }[]` lists the
  constraints/deadlines leveling made a task break although it met them before (nothing left to try); empty
  means nothing new is broken. Leveling still moves tasks in whole working days.
