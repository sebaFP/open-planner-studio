// Controles de la entrada `headless/pyc-motor` (API JSON en español): hitos de fin tras FS, MSO duro,
// holgura en tareas fuera de secuencia y nivelación que respeta restricciones. Exit 0 = verde.
// Mutantes: quitar el tipo de hito de fin, el `hard` del MSO, el cálculo de la holgura con el trabajo
// restante, la guarda de pin o la ronda de «colocar primero» en la nivelación ⇒ rojo (A, B, C, E).
// La entrada lee `__OPS_CORE_VERSION__` (una constante de compilación que `build-pyc-motor.mjs` define):
// el arnés de pruebas no la define, así que se fija antes de cargar el módulo.
(globalThis as { __OPS_CORE_VERSION__?: string }).__OPS_CORE_VERSION__ = 'test';
const { programar, nivelar } = await import('../../headless/pyc-motor/index');
import type { Modelo, MTarea, MRelacion } from '../../headless/pyc-motor/api';

const diffs: string[] = [];
let checks = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`${label}: esperado ${JSON.stringify(want)}, obtenido ${JSON.stringify(got)}`);
};
const ok = (label: string, cond: boolean, detalle = '') => {
  checks++;
  if (!cond) diffs.push(`${label} ${detalle}`);
};

const cal24 = { id: 'c24', nombre: '7x24', diasLaborales: [1, 2, 3, 4, 5, 6, 7], horasDia: 24, horaInicio: 0, feriados: [] };
const cal5 = { id: 'c5', nombre: '5x8', diasLaborales: [1, 2, 3, 4, 5], horasDia: 8, horaInicio: 8, feriados: [] };
const T = (id: string, dur: number, extra: Partial<MTarea> = {}): MTarea => ({
  id, nombre: id, parentId: null, orden: 0, tipo: dur === 0 ? 'hito' : 'tarea', duracionDias: dur, inicio: '2026-01-05', avance: 0, ...extra,
}) as MTarea;
const R = (p: string, s: string, tipo: MRelacion['tipo'] = 'FS', lag = 0): MRelacion => ({
  id: `${p}-${s}-${tipo}${lag}`, predecesoraId: p, sucesoraId: s, tipo, desfaseDias: lag,
}) as MRelacion;
const M = (
  tareas: MTarea[], relaciones: MRelacion[],
  o: { cal?: string; perfil?: 'ops' | 'p6' | 'msproject'; fe?: string | null; recursos?: Modelo['recursos']; asig?: Modelo['asignaciones'] } = {},
): Modelo => ({
  proyecto: { nombre: 't', inicio: '2026-01-05', perfil: o.perfil ?? 'ops', calendarioId: o.cal ?? 'c24', fechaEstado: o.fe ?? null, umbralCasiCritica: null },
  calendarios: [cal24, cal5], tareas, relaciones, recursos: o.recursos ?? [], asignaciones: o.asig ?? [],
}) as Modelo;
const por = (r: ReturnType<typeof programar>, id: string) => r.tareas.find(t => t.id === id)!;
const fechas = (r: ReturnType<typeof programar>, id: string) => `${por(r, id).inicio}..${por(r, id).fin}`;

// ── A. Un hito tras FS cae en el instante de fin de la predecesora ────────────────────────────
{
  const r = programar(M([T('A', 5), T('M', 0, { fechaLimite: '2026-01-09' })], [R('A', 'M')], { cal: 'c5' }));
  eq('A1 5x8: hito el viernes 9', fechas(r, 'M'), '2026-01-09..2026-01-09');
  eq('A1 fin del proyecto', r.finProyecto, '2026-01-09');
  eq('A1 sin fecha límite incumplida', r.fechasLimiteIncumplidas, []);
  eq('A1 holgura del hito', por(r, 'M').holguraTotal, 0);
  ok('A1 hito crítico', por(r, 'M').critica);
}
for (const perfil of ['ops', 'p6', 'msproject'] as const) {
  const r = programar(M([T('A', 5), T('M', 0, { restriccion: { tipo: 'FNLT', fecha: '2026-01-09' } })], [R('A', 'M')], { cal: 'c5', perfil }));
  eq(`A2 ${perfil} FNLT cumplido`, [fechas(r, 'M'), r.restriccionesVioladas], ['2026-01-09..2026-01-09', []]);
}
{
  const r = programar(M([T('A', 3), T('M', 0)], [R('A', 'M')], { cal: 'c5' }));
  eq('A3 5x8 mitad de semana: hito el miércoles 7', fechas(r, 'M'), '2026-01-07..2026-01-07');
  const r24 = programar(M([T('A', 3), T('M', 0, { fechaLimite: '2026-01-07' })], [R('A', 'M')]));
  eq('A4 7x24: inicio = fin = último día de A', fechas(r24, 'M'), '2026-01-07..2026-01-07');
  eq('A4 sin incumplimiento', r24.fechasLimiteIncumplidas, []);
  eq('A4 fin del proyecto', r24.finProyecto, '2026-01-07');
}
{
  // Hito como predecesora: la tarea que sigue empieza en el siguiente instante laboral.
  const r = programar(M([T('A', 3), T('M', 0), T('B', 2)], [R('A', 'M'), R('M', 'B')], { cal: 'c5' }));
  eq('A5 5x8 hito→tarea', [fechas(r, 'M'), fechas(r, 'B')], ['2026-01-07..2026-01-07', '2026-01-08..2026-01-09']);
  const rv = programar(M([T('A', 5), T('M', 0), T('B', 1)], [R('A', 'M'), R('M', 'B')], { cal: 'c5' }));
  eq('A6 5x8 hito del viernes→tarea el lunes', [fechas(rv, 'M'), fechas(rv, 'B')], ['2026-01-09..2026-01-09', '2026-01-12..2026-01-12']);
  const r24 = programar(M([T('A', 3), T('M', 0), T('B', 2)], [R('A', 'M'), R('M', 'B')]));
  eq('A7 7x24 hito→tarea', [fechas(r24, 'M'), fechas(r24, 'B')], ['2026-01-07..2026-01-07', '2026-01-08..2026-01-09']);
  // Holguras: A (5d) y X (3d) en paralelo hacia el hito.
  const rh = programar(M([T('A', 5), T('X', 3), T('M', 0)], [R('A', 'M'), R('X', 'M')], { cal: 'c5' }));
  eq('A8 holguras', [por(rh, 'A').holguraTotal, por(rh, 'X').holguraTotal, por(rh, 'M').holguraTotal], [0, 2, 0]);
  eq('A8 ruta crítica', rh.rutaCritica.slice().sort(), ['A', 'M']);
  // Un hito sin predecesoras ni FS conserva su día de inicio.
  const ri = programar(M([T('M', 0, { inicio: '2026-01-07' }), T('B', 2)], [R('M', 'B')]));
  eq('A9 hito inicial intacto', [fechas(ri, 'M'), fechas(ri, 'B')], ['2026-01-07..2026-01-07', '2026-01-07..2026-01-08']);
}

// ── B. MSO es un pin duro: manda sobre la lógica y la relación violada se informa ─────────────
for (const perfil of ['ops', 'p6', 'msproject'] as const) {
  const r = programar(M([T('A', 3), T('B', 2, { restriccion: { tipo: 'MSO', fecha: '2026-01-06' } })], [R('A', 'B')], { perfil }));
  eq(`B1 ${perfil} B queda en el 6`, fechas(r, 'B'), '2026-01-06..2026-01-07');
  eq(`B1 ${perfil} holgura de B`, por(r, 'B').holguraTotal, 0);
  ok(`B1 ${perfil} holgura negativa en A`, por(r, 'A').holguraTotal < 0, String(por(r, 'A').holguraTotal));
  ok(`B1 ${perfil} informa la violación`, r.restriccionesVioladas.includes('B'), JSON.stringify(r.restriccionesVioladas));
}
{
  const r = programar(M([T('A', 3), T('B', 2, { restriccion: { tipo: 'MSO', fecha: '2026-01-12' } })], [R('A', 'B')]));
  eq('B2 MSO posterior a la lógica', [fechas(r, 'B'), r.restriccionesVioladas], ['2026-01-12..2026-01-13', []]);
}

{
  // Una MSO anterior a la fecha de estado en una tarea sin avance: el motor la deja en la fecha de estado y
  // lo informa (nunca la mueve al pasado ni calla que no se sostuvo).
  const r = programar(M([T('B', 2, { restriccion: { tipo: 'MSO', fecha: '2026-01-06' } })], [], { fe: '2026-01-09' }));
  eq('B3 MSO antes de la fecha de estado: no va al pasado', fechas(r, 'B'), '2026-01-09..2026-01-10');
  eq('B3 y se informa', r.restriccionesVioladas, ['B']);
}

// ── C. Fuera de secuencia: la holgura no usa el inicio real, sino el del trabajo restante ─────
for (const perfil of ['ops', 'p6', 'msproject'] as const) {
  const r = programar(M(
    [T('A', 6, { avance: 0.5, inicioReal: '2026-01-05' }), T('B', 4, { avance: 0.5, inicioReal: '2026-01-06' })],
    [R('A', 'B')], { perfil, fe: '2026-01-09' }));
  eq(`C1 ${perfil} A sin holgura negativa`, [por(r, 'A').holguraTotal, por(r, 'A').holguraLibre], [0, 0]);
  eq(`C1 ${perfil} B`, por(r, 'B').holguraTotal, 0);
  eq(`C1 ${perfil} sin restricciones`, r.restriccionesVioladas, []);
}

// ── E. La nivelación respeta restricciones ────────────────────────────────────────────────────
const res = [{ id: 'R', nombre: 'R', tipo: 'equipo', capacidadDia: 1 }] as Modelo['recursos'];
const asg = (...ids: string[]) => ids.map(i => ({ id: `a${i}`, tareaId: i, recursoId: 'R', unidadesDia: 1 })) as Modelo['asignaciones'];
const retraso = (lv: ReturnType<typeof nivelar>, id: string) => lv.retrasos[id] ?? 0;
{
  const m = M([T('A', 3), T('B', 2, { restriccion: { tipo: 'MSO', fecha: '2026-01-06' } })], [], { recursos: res, asig: asg('A', 'B') });
  const lv = nivelar(m);
  eq('E1 MSO no se mueve y A espera', [retraso(lv, 'A'), retraso(lv, 'B')], [3, 0]);
  eq('E1 nada queda sin resolver ni con aviso', [Object.keys(lv.sinResolver).length, lv.avisos.length], [0, 0]);
  // Lo que la nivelación dice debe coincidir con lo que programar() calcula después.
  const m2 = structuredClone(m);
  for (const t of m2.tareas) t.retrasoNivelacionDias = lv.retrasos[t.id] ?? null;
  const r = programar(m2);
  eq('E1 programado: B en el 6, A después', [fechas(r, 'B'), fechas(r, 'A'), r.restriccionesVioladas], ['2026-01-06..2026-01-07', '2026-01-08..2026-01-10', []]);
}
{
  const m = M([T('A', 3), T('B', 2, { restriccion: { tipo: 'MFO', fecha: '2026-01-07' } })], [], { recursos: res, asig: asg('A', 'B') });
  const lv = nivelar(m);
  eq('E2 MFO no se mueve', [retraso(lv, 'A'), retraso(lv, 'B'), lv.avisos.length], [3, 0, 0]);
}
{
  // Dos pins que chocan: ninguno se mueve y el choque se informa en sinResolver.
  const m = M([
    T('A', 3, { restriccion: { tipo: 'MSO', fecha: '2026-01-05' } }),
    T('B', 2, { restriccion: { tipo: 'MSO', fecha: '2026-01-06' } }),
  ], [], { recursos: res, asig: asg('A', 'B') });
  const lv = nivelar(m);
  eq('E1b dos pins en choque: sin retrasos', [retraso(lv, 'A'), retraso(lv, 'B')], [0, 0]);
  ok('E1b el choque se informa', Object.keys(lv.sinResolver).length > 0, JSON.stringify(lv.sinResolver));
}
{
  const m = M([T('A', 3), T('B', 2, { restriccion: { tipo: 'SNLT', fecha: '2026-01-06' } })], [], { recursos: res, asig: asg('A', 'B') });
  const lv = nivelar(m);
  eq('E3 SNLT: se retrasa A, no B', [retraso(lv, 'A'), retraso(lv, 'B')], [2, 0]);
  eq('E3 sin avisos', lv.avisos, []);
}
{
  const m = M([T('A', 3), T('B', 2, { fechaLimite: '2026-01-07' })], [], { recursos: res, asig: asg('A', 'B') });
  const lv = nivelar(m);
  eq('E4 fecha límite: se retrasa A', [retraso(lv, 'A'), retraso(lv, 'B')], [2, 0]);
  eq('E4 sin avisos', lv.avisos, []);
}
{
  // Sin salida: las dos tienen un límite que no se puede cumplir juntas.
  const m = M([T('A', 3, { restriccion: { tipo: 'SNLT', fecha: '2026-01-05' } }), T('B', 2, { restriccion: { tipo: 'SNLT', fecha: '2026-01-05' } })], [], { recursos: res, asig: asg('A', 'B') });
  const lv = nivelar(m);
  eq('E5 sin salida: una sola restricción en aviso', lv.avisos.map(a => a.tipo), ['restriccion']);
}
{
  // Sin conflicto de recursos: la nivelación no toca nada ni avisa.
  const m = M([T('A', 3), T('B', 2, { restriccion: { tipo: 'SNLT', fecha: '2026-01-06' } })], [], { recursos: res, asig: asg('A') });
  const lv = nivelar(m);
  eq('E6 sin conflicto', [lv.retrasos, lv.avisos], [{}, []]);
}

if (diffs.length) {
  console.log(`XX  check-pyc-motor: ${diffs.length} de ${checks} controles fallan`);
  for (const d of diffs) console.log('  - ' + d);
  process.exit(1);
}
console.log(`OK  check-pyc-motor: ${checks} controles`);
