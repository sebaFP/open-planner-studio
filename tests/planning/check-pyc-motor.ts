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

{
  // Hitos con SS/SF entrantes y salientes, y con restricciones, en 7x24 y 5x8: el resultado es siempre un solo
  // día (inicio = fin), las relaciones salientes SS/SF no agregan un día y no aparece holgura falsa.
  const resumen = (r: ReturnType<typeof programar>) => r.tareas.map(t => `${t.id} ${t.inicio}..${t.fin} TF${t.holguraTotal}`).join(' | ');
  const casos: [string, Modelo, string][] = [
    ['U1 7x24 A→M FS, M→B SS', M([T('A', 3), T('M', 0), T('B', 2)], [R('A', 'M'), R('M', 'B', 'SS')]),
      'A 2026-01-05..2026-01-07 TF0 | M 2026-01-07..2026-01-07 TF0 | B 2026-01-08..2026-01-09 TF0'],
    ['U2 5x8 A→M FS, M→B SS', M([T('A', 3), T('M', 0), T('B', 2)], [R('A', 'M'), R('M', 'B', 'SS')], { cal: 'c5' }),
      'A 2026-01-05..2026-01-07 TF0 | M 2026-01-07..2026-01-07 TF0 | B 2026-01-08..2026-01-09 TF0'],
    ['U3 7x24 A→M FS, M→B SF (sin holgura falsa)', M([T('A', 3), T('M', 0), T('B', 2)], [R('A', 'M'), R('M', 'B', 'SF')]),
      'A 2026-01-05..2026-01-07 TF0 | M 2026-01-07..2026-01-07 TF0 | B 2026-01-06..2026-01-07 TF0'],
    ['U4 5x8 A→M FS, M→B SF', M([T('A', 3), T('M', 0), T('B', 2)], [R('A', 'M'), R('M', 'B', 'SF')], { cal: 'c5' }),
      'A 2026-01-05..2026-01-07 TF0 | M 2026-01-07..2026-01-07 TF0 | B 2026-01-06..2026-01-07 TF0'],
    ['U5 7x24 hito MFO 01-08 sin entrante', M([T('M', 0, { restriccion: { tipo: 'MFO', fecha: '2026-01-08' } }), T('B', 1)], [R('M', 'B')]),
      'M 2026-01-08..2026-01-08 TF0 | B 2026-01-09..2026-01-09 TF0'],
    ['U6 7x24 hito FNET 01-08 sin entrante', M([T('M', 0, { restriccion: { tipo: 'FNET', fecha: '2026-01-08' } }), T('B', 1)], [R('M', 'B')]),
      'M 2026-01-08..2026-01-08 TF0 | B 2026-01-09..2026-01-09 TF0'],
    ['U6b 7x24 hito solo con FNLT al inicio del proyecto (no retrocede antes del inicio)', M([T('M', 0, { restriccion: { tipo: 'FNLT', fecha: '2026-01-08' } }), T('B', 1)], [R('M', 'B')]),
      'M 2026-01-05..2026-01-05 TF3 | B 2026-01-05..2026-01-05 TF3'],
    ['U7 7x24 hito con FS entrante y MSO 01-08', M([T('A', 1), T('M', 0, { restriccion: { tipo: 'MSO', fecha: '2026-01-08' } })], [R('A', 'M')]),
      'A 2026-01-05..2026-01-05 TF2 | M 2026-01-08..2026-01-08 TF0'],
    ['U8 7x24 hito con FS entrante y SNET 01-08', M([T('A', 1), T('M', 0, { restriccion: { tipo: 'SNET', fecha: '2026-01-08' } })], [R('A', 'M')]),
      'A 2026-01-05..2026-01-05 TF2 | M 2026-01-08..2026-01-08 TF0'],
    ['U9 5x8 hito FS entrante y SNET 01-12', M([T('A', 3), T('M', 0, { restriccion: { tipo: 'SNET', fecha: '2026-01-12' } })], [R('A', 'M')], { cal: 'c5' }),
      'A 2026-01-05..2026-01-07 TF2 | M 2026-01-12..2026-01-12 TF0'],
    ['U10 5x8 hito solo con SS entrante', M([T('A', 3), T('M', 0)], [R('A', 'M', 'SS')], { cal: 'c5' }),
      'A 2026-01-05..2026-01-07 TF0 | M 2026-01-05..2026-01-05 TF2'],
    ['U11 5x8 hito solo con SF entrante', M([T('A', 3), T('M', 0)], [R('A', 'M', 'SF')], { cal: 'c5' }),
      'A 2026-01-05..2026-01-07 TF0 | M 2026-01-05..2026-01-05 TF3'],
    ['U12 5x8 hito con FS y SS entrantes (sin holguras espurias)', M([T('A', 3), T('B', 2, { inicio: '2026-01-12' }), T('M', 0)], [R('A', 'M'), R('B', 'M', 'SS')], { cal: 'c5' }),
      'A 2026-01-05..2026-01-07 TF3 | B 2026-01-12..2026-01-13 TF0 | M 2026-01-12..2026-01-12 TF1'],
    ['U13 7x24 hito con FS y SF entrantes', M([T('A', 3), T('B', 2), T('M', 0)], [R('A', 'M'), R('B', 'M', 'SF')]),
      'A 2026-01-05..2026-01-07 TF0 | B 2026-01-05..2026-01-06 TF1 | M 2026-01-08..2026-01-08 TF0'],
  ];
  for (const [label, m, esperado] of casos) {
    const r = programar(m);
    eq(label, resumen(r), esperado);
    ok(`${label}: nunca inicio > fin`, r.tareas.every(t => t.inicio <= t.fin), JSON.stringify(r.tareas.map(t => [t.id, t.inicio, t.fin])));
  }
  // Un hito con clase propia (viene de un archivo) la conserva: de inicio ⇒ el motor lo corre al siguiente
  // día laboral como siempre; de fin ⇒ queda en el fin de la predecesora.
  const origenHito = (kind: 'START' | 'FINISH') => JSON.stringify({
    id: 'M', name: 'M', description: '', wbsCode: '', taskType: 'CONSTRUCTION', status: 'NOT_STARTED', isMilestone: true, milestoneKind: kind,
    priority: 500, parentId: null, childIds: [], resourceIds: [],
    time: { durationType: 'WORKTIME', durationUnit: 'days', scheduleDuration: 0, scheduleStart: '2026-01-05', scheduleFinish: '2026-01-05', earlyStart: '2026-01-05', earlyFinish: '2026-01-05', lateStart: '2026-01-05', lateFinish: '2026-01-05', freeFloat: 0, totalFloat: 0, isCritical: false, completion: 0 },
  });
  for (const kind of ['START', 'FINISH'] as const) {
    const r = programar(M([T('A', 5), T('M', 0, { original: origenHito(kind) })], [R('A', 'M')], { cal: 'c5' }));
    eq(`U14 hito con clase propia ${kind}`, fechas(r, 'M'), kind === 'FINISH' ? '2026-01-09..2026-01-09' : '2026-01-12..2026-01-12');
  }
  // msproject: una predecesora terminada con fin real sin hora no adelanta el hito un día laboral.
  const rp = programar(M([T('A', 5, { avance: 1, inicioReal: '2026-01-05', finReal: '2026-01-09' }), T('M', 0), T('B', 2)], [R('A', 'M'), R('M', 'B')], { cal: 'c5', perfil: 'msproject', fe: '2026-01-12' }));
  eq('U15 msproject, A terminada: hito el día del fin real', [fechas(rp, 'M'), fechas(rp, 'B')], ['2026-01-09..2026-01-09', '2026-01-12..2026-01-13']);
  const rq = programar(M([T('A', 5, { avance: 0.5, inicioReal: '2026-01-05' }), T('M', 0)], [R('A', 'M')], { cal: 'c5', perfil: 'msproject', fe: '2026-01-07' }));
  eq('U16 msproject, A en curso: hito al terminar A', fechas(rq, 'M'), '2026-01-09..2026-01-09');
}

// ── B. MSO es un pin duro: manda sobre la lógica y la relación violada se informa ─────────────
for (const perfil of ['ops', 'p6', 'msproject'] as const) {
  const r = programar(M([T('A', 3), T('B', 2, { restriccion: { tipo: 'MSO', fecha: '2026-01-06' } })], [R('A', 'B')], { perfil }));
  eq(`B1 ${perfil} B queda en el 6`, fechas(r, 'B'), '2026-01-06..2026-01-07');
  eq(`B1 ${perfil} holgura de B`, por(r, 'B').holguraTotal, 0);
  eq(`B1 ${perfil} holgura de A (relación violada)`, por(r, 'A').holguraTotal, -2);
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

{
  // C en secuencia: una tarea en curso cuya predecesora terminó, o una en curso sola, no cambia (sin holgura
  // espuria en la predecesora ni inicio tardío distinto del temprano con holgura 0).
  const enSecuencia = M([T('A', 3, { avance: 1, inicioReal: '2026-01-05', finReal: '2026-01-07' }), T('B', 4, { avance: 0.5, inicioReal: '2026-01-08' })], [R('A', 'B')], { cal: 'c5', fe: '2026-01-09' });
  for (const [perfil, tfA] of [['ops', 0], ['msproject', 1]] as const) {
    const m = structuredClone(enSecuencia); m.proyecto.perfil = perfil;
    const r = programar(m);
    eq(`C2 ${perfil} en secuencia: holgura de A y B`, [por(r, 'A').holguraTotal, por(r, 'B').holguraTotal], [tfA, 0]);
  }
  const sola = programar(M([T('B', 4, { avance: 0.5, inicioReal: '2026-01-05' })], [], { cal: 'c5', fe: '2026-01-07' }));
  eq('C3 tarea en curso sola: inicio tardío = temprano, holgura 0', [por(sola, 'B').inicioTardio, por(sola, 'B').inicioTemprano, por(sola, 'B').holguraTotal], ['2026-01-05', '2026-01-05', 0]);
}
{
  // Restricciones importadas sin editar conservan el significado de su herramienta: la MSO «suave» de P6
  // («Start On») sigue suave y la obligatoria (P6 Mandatory Start, MS Project Must Start On) sigue dura;
  // si se edita la fecha pasa a ser un pin duro. (La asignación de `hard` por formato la hacen los lectores.)
  const origen = (constraint: object) => JSON.stringify({
    id: 'B', name: 'B', description: '', wbsCode: '', taskType: 'CONSTRUCTION', status: 'NOT_STARTED', isMilestone: false,
    priority: 500, parentId: null, childIds: [], resourceIds: [], constraint,
    time: { durationType: 'WORKTIME', durationUnit: 'days', scheduleDuration: 2, scheduleStart: '2026-01-05', scheduleFinish: '2026-01-05', earlyStart: '2026-01-05', earlyFinish: '2026-01-05', lateStart: '2026-01-05', lateFinish: '2026-01-05', freeFloat: 0, totalFloat: 0, isCritical: false, completion: 0 },
  });
  const con = (constraint: object, fecha = '2026-01-06') =>
    programar(M([T('A', 3), T('B', 2, { restriccion: { tipo: 'MSO', fecha }, original: origen(constraint) })], [R('A', 'B')]));
  const suave = con({ type: 'MSO', date: '2026-01-06' });
  eq('H1 MSO suave del archivo (P6 Start On) sigue suave: la lógica manda', [fechas(suave, 'B'), suave.restriccionesVioladas], ['2026-01-08..2026-01-09', ['B']]);
  const dura = con({ type: 'MSO', date: '2026-01-06', hard: true });
  eq('H2 MSO dura del archivo (Mandatory Start / Must Start On) sigue dura', [fechas(dura, 'B'), dura.restriccionesVioladas], ['2026-01-06..2026-01-07', ['B']]);
  const editada = con({ type: 'MSO', date: '2026-01-06' }, '2026-01-07');
  eq('H3 fecha editada: pin duro', fechas(editada, 'B'), '2026-01-07..2026-01-08');
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
