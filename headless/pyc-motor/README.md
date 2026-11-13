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
  instant (5x8: Friday stays Friday, not the next Monday) and shows `inicio = fin` on that day. This kind
  (`FINISH`) is only assigned when it is unambiguous: an incoming FS/FF, no incoming SS/SF and no start
  constraint (MSO/SNET/SNLT). Otherwise the milestone has no kind and the engine infers it as before. A
  milestone read from a file keeps its own kind. Outgoing SS/SF relations from a finish milestone do not add a
  day. A milestone with an MFO/FNET/FNLT constraint shows the day the finish falls on. A finished
  predecessor's `finReal` (a date) counts as the end of that working day when it feeds a finish milestone.
  A finish milestone carries `hitoDeFin: true` in its result, so a Gantt can draw it at the end of its day
  (where the predecessor's bar ends) instead of at the start.
- **`restriccion` MSO / MFO** set from the model are hard pins in every profile: the date wins over the logic and
  a relation it breaks stays reported (`restriccionesVioladas`, negative float on the predecessor). A pin pushed
  past its date by the status date is reported too.
- **Constraints read from a file keep the meaning they have in the tool that wrote them** (the element is kept
  in `original`): P6 «Start On» / «Finish On» (`CS_MSO`/`CS_MEO`) stay soft; P6 «Mandatory Start/Finish»
  (`CS_MANDSTART`/`CS_MANDFIN`) and MS Project «Must Start On» / «Must Finish On» (codes 2/3, MSPDI and .mpp)
  are hard. The readers set `hard` that way. If the model changes the constraint (type or date) it becomes a
  hard pin like any other set from the model.
- **Float of a predecessor of a task that is in progress and out of sequence** (OPS and MS Project profiles)
  is measured against the start of the successor's remaining work, not its actual start; in sequence nothing
  changes.
- **`nivelar`** never moves a MSO/MFO task (it books as fixed load; two pins that collide are listed in
  `sinResolver`). When several tasks could wait it prefers the one that does not break its own
  SNLT/FNLT/`fechaLimite`, even if that makes the project end later: it repeats the leveling (up to 4 extra
  rounds) placing first the tasks that would break a limit, and keeps the result with the fewest broken limits.
  A pin that gets broken by logic does not trigger another round (it cannot move). The extra rounds are not run
  when a pool ledger is passed.
- **`avisos`** (`{ tareaId, tipo: 'restriccion' | 'fechaLimite' }[]`) lists ONLY what leveling broke: a
  constraint or deadline that the task met before leveling and no longer meets. What was already broken before
  leveling (and stays broken) is not listed; read it from `programar` (`restriccionesVioladas`,
  `fechasLimiteIncumplidas`). Empty means leveling broke nothing new. Leveling still moves tasks in whole
  working days.

## Real dates and finished predecessors (p6 programs read from a file)

- **Real dates are shown as the fact says**: a task with `inicioReal` / `finReal` returns exactly those dates as
  `inicio` / `fin` (P6 stores `act_end 2026-09-20 00:00` and shows 20-Sep-26; the engine used to read the 00:00 as
  the end of the 19th). The bar, the Fin column and `finReal` always agree.
- **A relation out of a task with real dates anchors on the real dates**, never on the file's old
  early/schedule dates: SS/SF measure the lag from the predecessor's real start, FS/FF from its real finish (the
  remaining lag after a finished predecessor is `lag - worked time since that anchor up to the status date`), and a
  root task with a real start before its old `scheduleStart` contributes that real start to the project-start
  floor (a stale 02-Nov window used to floor every successor of a task that began on 01-Aug).
- **Profile p6 only**: a finished predecessor whose real finish is after the status date does not push its
  successor beyond the status date (P6 schedules it on the status date). It is convention C1
  `p6CompletedPredecessorAtDataDate`, off in the registry's built-in p6 profile; this entry point switches it on as
  an override of the p6 profile (the registry and the other profiles are untouched) unless the profile already
  sets it. Other profiles keep pushing the successor past the finish.
