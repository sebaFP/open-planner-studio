// pyc-motor: the scheduling core of Open Planner Studio behind a plain-JSON model (see ./api.ts).
//
// Everything here only TRANSLATES between that model and the app's own types and calls the existing
// engine and file adapters unchanged:
//   - CPM:       `solveProject` (src/engine/scheduler/solveProject.ts) via `solveInputFor`
//   - leveling:  `levelResources` (src/engine/scheduler/ResourceLeveler.ts)
//   - readers:   `parseOpenedFile` (src/services/formatRegistry.ts): XER, P6 XML, MSPDI, MPP, CSV
//   - writers:   `writeMSPDIWithReport`, `writeP6XMLWithReport`, `writeXER`, `writeCSV`
// Node and Web Workers have no `DOMParser`; the headless XML DOM of the MCP server is installed on
// first use (it refuses DTD entities).
//
// License: LGPL-3.0-or-later, like the rest of the repository.
import type { Task, TaskConstraint } from '@/types/task';
import type { Sequence, SequenceType } from '@/types/sequence';
import type { WorkCalendar } from '@/types/calendar';
import type { Project, BuiltInProfileId } from '@/types/project';
import type { Resource, ResourceAssignment, ResourceType } from '@/types/resource';
import type { Baseline } from '@/types/baseline';
import type { ImportResult } from '@/services/importTypes';
import { isMultiDocumentImport } from '@/services/importTypes';
import { parseOpenedFile, detectXmlFlavor } from '@/services/formatRegistry';
import { solveProject, cloneTasksForSolve } from '@/engine/scheduler/solveProject';
import { solveInputFor, solveOptionsFor } from '@/engine/scheduler/solveInput';
import { levelResources } from '@/engine/scheduler/ResourceLeveler';
import type { CPMResult } from '@/engine/scheduler/CPMSolver';
import { builtInProfile } from '@/engine/scheduler/conventions/registry';
import { writeMSPDIWithReport } from '@/services/msproject/mspdiWriter';
import { writeP6XMLWithReport } from '@/services/p6/p6xmlWriter';
import { writeXER } from '@/services/xer/xerWriter';
import { writeCSV } from '@/services/csv/csvWriter';
import { installXmlDomParser } from '../mcp-server/src/xmlDom';
import type {
  CodigoErrorMotor, FormatoEscritura, MCalendario, MotivoFecha, MRelacion, MTarea, Modelo, Perfil,
  ProyectoLeido, ResultadoEscritura, ResultadoLectura, ResultadoNivelacion, ResultadoProgramacion,
  ResultadoTarea, TipoRecurso, TipoRelacion,
} from './api';

export type * from './api';

declare const __OPS_CORE_VERSION__: string;
/** Version of Open Planner Studio this bundle was built from. */
export const VERSION_OPS: string = __OPS_CORE_VERSION__;

export class ErrorMotor extends Error {
  readonly codigo: CodigoErrorMotor;
  constructor(codigo: CodigoErrorMotor, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorMotor';
    this.codigo = codigo;
  }
}

// ---------------------------------------------------------------------------------------------
// Model → OPS

const TIPO_A_SEQ: Record<TipoRelacion, SequenceType> = {
  FS: 'FINISH_START', SS: 'START_START', FF: 'FINISH_FINISH', SF: 'START_FINISH',
};
const SEQ_A_TIPO: Record<SequenceType, TipoRelacion> = {
  FINISH_START: 'FS', START_START: 'SS', FINISH_FINISH: 'FF', START_FINISH: 'SF',
};
const RECURSO_A_OPS: Record<TipoRecurso, ResourceType> = {
  equipo: 'EQUIPMENT', dotacion: 'LABOR', material: 'MATERIAL', subcontrato: 'SUBCONTRACTOR',
};

const fecha = (s: string | null | undefined): string | undefined => (s ? s.slice(0, 10) : undefined);
/** A finish instant at 00:00 (24-hour calendars end at midnight) belongs to the previous day: the
 *  model's finish is the last working DATE, inclusive. */
function fechaFin(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0+)?)?(?:Z)?$/.exec(s);
  if (!m) return s.slice(0, 10);
  const d = new Date(`${m[1]}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function aCalendario(c: MCalendario): WorkCalendar {
  const horas = Math.min(24, Math.max(1, c.horasDia || 8));
  // The working band must fit in the day: a 21-hour day starting at 07:00 starts at 03:00 instead.
  const inicio = Math.max(0, Math.min(c.horaInicio ?? (horas >= 24 ? 0 : 8), 24 - horas));
  return {
    id: c.id,
    name: c.nombre,
    description: '',
    workDays: [...new Set(c.diasLaborales)].filter((d) => d >= 1 && d <= 7).sort(),
    workStartHour: inicio,
    workEndHour: Math.min(24, inicio + horas),
    hoursPerDay: horas,
    holidays: c.feriados.map((f) => ({ name: f.nombre, startDate: f.desde, endDate: f.hasta })),
    ...(c.diasExtra?.length
      ? { workingExceptions: c.diasExtra.map((f) => ({ name: f.nombre, startDate: f.desde, endDate: f.hasta })) }
      : {}),
  } as WorkCalendar;
}

// ── Fidelity: start from the element as read from the file and override only what changed ──

function leer<T>(json: string | null | undefined): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** Working days of an OPS task as the model counts them (hours → days on its calendar). */
function diasDeTask(t: Task, horasDia: number): number {
  const x = t.time;
  const d = x.durationUnit === 'hours' && x.durationMinutes != null ? x.durationMinutes / 60 / horasDia : x.scheduleDuration;
  return Math.round((d || 0) * 1000) / 1000;
}

function lagDeSeq(s: Sequence, horasDia: number): number {
  const d = s.lagMinutes != null ? s.lagMinutes / 60 / horasDia : s.lagDays;
  return Math.round((d || 0) * 1000) / 1000;
}

const mismoNumero = (a: number | null | undefined, b: number | null | undefined) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-6;
const listaFechas = (l: { desde: string; hasta: string }[] | undefined) =>
  (l ?? []).map((f) => `${f.desde}|${f.hasta}`).sort().join(',');

function aCalendarioFiel(c: MCalendario): WorkCalendar {
  const nuestro = aCalendario(c);
  const o = leer<WorkCalendar>(c.original);
  if (!o) return nuestro;
  const visto = desdeCalendario(o);
  const igual =
    [...visto.diasLaborales].sort().join() === [...c.diasLaborales].sort().join() &&
    mismoNumero(visto.horasDia, c.horasDia) &&
    listaFechas(visto.feriados) === listaFechas(c.feriados) &&
    listaFechas(visto.diasExtra) === listaFechas(c.diasExtra);
  return igual ? { ...o, id: c.id, name: c.nombre } : nuestro;
}

function calendarioPorDefecto(): MCalendario {
  return { id: 'cal-pyc', nombre: '7x24', diasLaborales: [1, 2, 3, 4, 5, 6, 7], horasDia: 24, feriados: [] };
}

function aProyecto(m: Modelo): Project {
  const nuestro = aProyectoBase(m);
  const o = leer<Project>(m.proyecto.original);
  if (!o) return nuestro;
  // Las opciones del archivo (P6/MSP) se conservan; lo que la carta fija (inicio,
  // fecha de estado, calendario, perfil si se cambió) manda.
  const mismoPerfil = (o.schedulingProfile?.baseId ?? m.proyecto.perfil) === m.proyecto.perfil;
  return {
    ...o,
    id: nuestro.id,
    name: nuestro.name,
    startDate: nuestro.startDate,
    calendarId: nuestro.calendarId,
    statusDate: nuestro.statusDate,
    schedulingProfile: mismoPerfil && o.schedulingProfile ? o.schedulingProfile : nuestro.schedulingProfile,
    schedulingOptions: { ...(o.schedulingOptions ?? {}), ...(nuestro.schedulingOptions ?? {}) },
  } as Project;
}

function aProyectoBase(m: Modelo): Project {
  const p = m.proyecto;
  const opciones: Record<string, unknown> = {};
  if (p.umbralCasiCritica != null) opciones.nearCriticalThreshold = p.umbralCasiCritica;
  if (p.caminosHolgura) opciones.floatPaths = { enabled: true, method: 'TOTAL_FLOAT', maxPaths: p.caminosHolgura };
  return {
    id: 'pyc',
    name: p.nombre,
    description: '',
    startDate: p.inicio,
    endDate: '',
    calendarId: p.calendarioId,
    createdAt: new Date(0).toISOString(),
    modifiedAt: new Date(0).toISOString(),
    author: '',
    company: '',
    ...(p.fechaEstado ? { statusDate: p.fechaEstado } : {}),
    schedulingProfile: builtInProfile(p.perfil as BuiltInProfileId),
    ...(Object.keys(opciones).length ? { schedulingOptions: opciones } : {}),
  } as Project;
}

interface Traducido {
  project: Project;
  calendar: WorkCalendar;
  calendars: WorkCalendar[];
  tasks: Task[];
  sequences: Sequence[];
  resources: Resource[];
  assignments: ResourceAssignment[];
  baselines: Baseline[];
}

function traducir(m: Modelo): Traducido {
  const calendariosM = m.calendarios.length ? m.calendarios : [calendarioPorDefecto()];
  const calendars = calendariosM.map(aCalendarioFiel);
  const horasDe = new Map(calendars.map((c) => [c.id, c.hoursPerDay || 8]));
  const calendar = calendars.find((c) => c.id === m.proyecto.calendarioId) ?? calendars[0];
  const ids = new Set(m.tareas.map((t) => t.id));
  const hijos = new Map<string, MTarea[]>();
  for (const t of m.tareas) {
    const padre = t.parentId && ids.has(t.parentId) ? t.parentId : '';
    const l = hijos.get(padre) ?? [];
    l.push(t);
    hijos.set(padre, l);
  }
  for (const l of hijos.values()) l.sort((a, b) => a.orden - b.orden);
  const recursosDe = new Map<string, string[]>();
  for (const a of m.asignaciones) {
    const l = recursosDe.get(a.tareaId) ?? [];
    l.push(a.recursoId);
    recursosDe.set(a.tareaId, l);
  }
  // Depth-first so the array follows the outline (the writers and WBS numbering rely on it).
  const tasks: Task[] = [];
  // Missing WBS codes get the outline number (1, 1.2, 1.2.3): CSV links predecessors by WBS code.
  const visitar = (padre: string, prefijo: string) => {
    (hijos.get(padre) ?? []).forEach((t, i) => {
      const numero = prefijo ? `${prefijo}.${i + 1}` : String(i + 1);
      const horas = horasDe.get(t.calendarioId ?? '') ?? calendar.hoursPerDay ?? 8;
      tasks.push(aTaskFiel({ ...t, wbs: t.wbs || numero }, padre || null, (hijos.get(t.id) ?? []).map((h) => h.id), recursosDe.get(t.id) ?? [], horas));
      visitar(t.id, numero);
    });
  };
  visitar('', '');
  const sequences: Sequence[] = m.relaciones
    .filter((r) => ids.has(r.predecesoraId) && ids.has(r.sucesoraId) && r.predecesoraId !== r.sucesoraId)
    .map((r) => {
      const nuestra: Sequence = {
        id: r.id, predecessorId: r.predecesoraId, successorId: r.sucesoraId,
        type: TIPO_A_SEQ[r.tipo] ?? 'FINISH_START', lagDays: r.desfaseDias || 0,
      };
      const o = leer<Sequence>(r.original);
      if (!o || o.type !== nuestra.type || !mismoNumero(lagDeSeq(o, calendar.hoursPerDay || 8), r.desfaseDias)) return nuestra;
      return { ...o, id: r.id, predecessorId: r.predecesoraId, successorId: r.sucesoraId };
    });
  const resources: Resource[] = m.recursos.map((r) => {
    const nuestro: Resource = {
      id: r.id, name: r.nombre, type: RECURSO_A_OPS[r.tipo] ?? 'EQUIPMENT', description: '',
      maxUnits: r.capacidadDia, ...(r.calendarioId ? { calendarId: r.calendarioId } : {}),
      ...(r.unidad ? { unitOfMeasure: r.unidad } : {}),
    };
    const o = leer<Resource>(r.original);
    if (!o) return nuestro;
    return { ...o, id: r.id, name: r.nombre, ...(mismoNumero(o.maxUnits, r.capacidadDia) ? {} : { maxUnits: r.capacidadDia, availabilitySteps: undefined }), calendarId: r.calendarioId ?? undefined };
  });
  const assignments: ResourceAssignment[] = m.asignaciones
    .filter((a) => ids.has(a.tareaId))
    .map((a) => {
      const nuestra = { id: a.id, taskId: a.tareaId, resourceId: a.recursoId, unitsPerDay: a.unidadesDia } as ResourceAssignment;
      const o = leer<ResourceAssignment>(a.original);
      if (!o || !mismoNumero(o.unitsPerDay, a.unidadesDia)) return nuestra;
      return { ...o, id: a.id, taskId: a.tareaId, resourceId: a.recursoId };
    });
  const baselines: Baseline[] = (m.lineasBase ?? []).map((b) => ({
    id: b.id, name: b.nombre, createdAt: b.creadaEn, projectEnd: '', projectDuration: 0,
    tasks: b.tareas.map((t) => ({ taskId: t.tareaId, start: t.inicio, finish: t.fin, duration: t.duracionDias, isMilestone: false })),
  }));
  return { project: aProyecto(m), calendar, calendars, tasks, sequences, resources, assignments, baselines };
}

/**
 * La tarea del archivo, con lo que cambió en la carta encima. Si la duración, el
 * avance o el inicio no cambiaron, quedan los del archivo (horas, restante de P6,
 * tipo de duración…): así una carta importada calcula igual que en P6 / Project.
 */
function aTaskFiel(t: MTarea, parentId: string | null, childIds: string[], resourceIds: string[], horas: number): Task {
  const nuestra = aTask(t, parentId, childIds, resourceIds);
  const o = leer<Task>(t.original);
  if (!o) return nuestra;
  const x = o.time;
  const mismaDur = mismoNumero(diasDeTask(o, horas), nuestra.time.scheduleDuration);
  const mismoAvance =
    mismoNumero(x.completion, nuestra.time.completion) &&
    fecha(x.actualStart) === nuestra.time.actualStart &&
    fecha(x.actualFinish) === nuestra.time.actualFinish;
  const mismoInicio = fecha(x.actualStart ?? x.scheduleStart ?? x.earlyStart) === nuestra.time.scheduleStart;
  const time = { ...x };
  if (!mismaDur) {
    Object.assign(time, { durationUnit: 'days', scheduleDuration: nuestra.time.scheduleDuration });
    delete time.durationMinutes;
    delete time.remainingMinutes;
    delete time.remainingTime;
  }
  if (!mismoAvance) {
    time.completion = nuestra.time.completion;
    time.actualStart = nuestra.time.actualStart;
    time.actualFinish = nuestra.time.actualFinish;
    delete time.remainingMinutes;
    delete time.remainingTime;
  }
  if (!mismoInicio) {
    time.scheduleStart = nuestra.time.scheduleStart;
    time.scheduleFinish = nuestra.time.scheduleStart;
  }
  const mismaRestriccion =
    (o.constraint?.type ?? 'ASAP') === (nuestra.constraint?.type ?? 'ASAP') &&
    fecha(o.constraint?.date) === fecha(nuestra.constraint?.date);
  const mismoRetraso = mismoNumero(o.levelingDelay, nuestra.levelingDelay);
  const salida: Task = {
    ...o,
    id: nuestra.id,
    name: nuestra.name,
    description: nuestra.description,
    wbsCode: nuestra.wbsCode,
    parentId: nuestra.parentId,
    childIds: nuestra.childIds,
    resourceIds: nuestra.resourceIds,
    isMilestone: nuestra.isMilestone,
    status: mismoAvance ? o.status : nuestra.status,
    constraint: mismaRestriccion ? o.constraint : nuestra.constraint,
    ...(mismaRestriccion ? {} : { constraint2: undefined }),
    deadline: nuestra.deadline,
    calendarId: nuestra.calendarId,
    levelingDelay: nuestra.levelingDelay,
    ...(mismoRetraso ? {} : { levelingDelayMinutes: undefined }),
    time,
  } as Task;
  if (!nuestra.isSummary && !childIds.length) delete (salida as { isSummary?: boolean }).isSummary;
  else salida.isSummary = true;
  if (nuestra.isHammock) salida.isHammock = true;
  else delete (salida as { isHammock?: boolean }).isHammock;
  return salida;
}

function aTask(t: MTarea, parentId: string | null, childIds: string[], resourceIds: string[]): Task {
  const hito = t.tipo === 'hito';
  const duracion = hito ? 0 : Math.max(0, Number.isFinite(t.duracionDias) ? t.duracionDias : 0);
  const avance = Math.min(1, Math.max(0, t.avance || 0));
  const inicio = fecha(t.inicio) ?? fecha(new Date().toISOString())!;
  const restriccion: TaskConstraint | undefined =
    t.restriccion && t.restriccion.tipo !== 'ASAP'
      ? { type: t.restriccion.tipo, ...(t.restriccion.fecha ? { date: fecha(t.restriccion.fecha) } : {}) }
      : undefined;
  return {
    id: t.id,
    name: t.nombre,
    description: t.notas ?? '',
    wbsCode: t.wbs ?? '',
    taskType: 'CONSTRUCTION',
    status: avance >= 1 || t.finReal ? 'COMPLETED' : avance > 0 || t.inicioReal ? 'STARTED' : 'NOT_STARTED',
    isMilestone: hito && childIds.length === 0,
    priority: 500,
    parentId,
    childIds,
    ...(t.tipo === 'resumen' || childIds.length ? { isSummary: true } : {}),
    ...(t.tipo === 'hamaca' ? { isHammock: true } : {}),
    ...(restriccion ? { constraint: restriccion } : {}),
    ...(t.fechaLimite ? { deadline: fecha(t.fechaLimite) } : {}),
    ...(t.calendarioId ? { calendarId: t.calendarioId } : {}),
    ...(t.retrasoNivelacionDias ? { levelingDelay: t.retrasoNivelacionDias } : {}),
    time: {
      durationType: 'WORKTIME',
      durationUnit: 'days',
      scheduleDuration: duracion,
      scheduleStart: inicio,
      scheduleFinish: inicio,
      earlyStart: inicio,
      earlyFinish: inicio,
      lateStart: inicio,
      lateFinish: inicio,
      freeFloat: 0,
      totalFloat: 0,
      isCritical: false,
      completion: avance,
      ...(t.inicioReal ? { actualStart: fecha(t.inicioReal) } : {}),
      ...(t.finReal ? { actualFinish: fecha(t.finReal) } : {}),
    },
    resourceIds,
  } as Task;
}

/** The engine and the adapters log developer notes (in Dutch) through console.warn/info. They are
 *  not for end users: collected and dropped while a call runs. */
function silencioso<T>(fn: () => T): T {
  const c = console as unknown as Record<string, (...a: unknown[]) => void>;
  const previos = { warn: c.warn, info: c.info, log: c.log };
  c.warn = c.info = c.log = () => {};
  try { return fn(); } finally { Object.assign(c, previos); }
}
async function silenciosoAsync<T>(fn: () => Promise<T>): Promise<T> {
  const c = console as unknown as Record<string, (...a: unknown[]) => void>;
  const previos = { warn: c.warn, info: c.info, log: c.log };
  c.warn = c.info = c.log = () => {};
  try { return await fn(); } finally { Object.assign(c, previos); }
}

// ---------------------------------------------------------------------------------------------
// CPM

function motivoDe(r: CPMResult, id: string): MotivoFecha | null {
  const d = r.dateDriverByTaskId?.[id];
  if (!d) return null;
  switch (d.kind) {
    case 'relation': return { tipo: 'relacion', predecesoras: d.predecessorIds };
    case 'constraint': return { tipo: 'restriccion' };
    case 'ownStart': case 'plannedStart': case 'manual': return { tipo: 'inicioPropio' };
    case 'projectStart': return { tipo: 'inicioProyecto' };
    case 'statusDate': return { tipo: 'fechaEstado' };
    case 'leveling': return { tipo: 'nivelacion' };
    case 'progress': return { tipo: 'avance' };
    default: return { tipo: 'otro' };
  }
}

function resolver(tr: Traducido, traza = true): CPMResult {
  const input = solveInputFor(tr.project, tr.tasks, tr.sequences, tr.calendar, tr.calendars);
  return silencioso(() => solveProject({ ...input, traceDateDrivers: traza }));
}

/** Run the critical path method on the model. Never mutates `modelo`. */
export function programar(modelo: Modelo): ResultadoProgramacion {
  validar(modelo);
  const tr = traducir(modelo);
  tr.tasks = cloneTasksForSolve(tr.tasks);
  let r: CPMResult;
  try {
    r = resolver(tr);
  } catch (e) {
    return vacio(e instanceof Error ? e.message : String(e), []);
  }
  if (r.error) return vacio(r.error, r.cycleTaskIds ?? []);
  const tareas: ResultadoTarea[] = tr.tasks.map((t) => {
    const c = r.tasks.get(t.id);
    const x = t.time;
    return {
      id: t.id,
      inicio: fecha(x.actualStart ?? x.earlyStart ?? x.scheduleStart)!,
      fin: fechaFin(x.actualFinish ?? x.earlyFinish ?? x.scheduleFinish)!,
      inicioTemprano: fecha(c?.earlyStart ?? x.earlyStart)!,
      finTemprano: fechaFin(c?.earlyFinish ?? x.earlyFinish)!,
      inicioTardio: fecha(c?.lateStart ?? x.lateStart)!,
      finTardio: fechaFin(c?.lateFinish ?? x.lateFinish)!,
      holguraTotal: c?.totalFloat ?? x.totalFloat ?? 0,
      holguraLibre: c?.freeFloat ?? x.freeFloat ?? 0,
      critica: c?.isCritical ?? x.isCritical ?? false,
      casiCritica: r.nearCriticalTaskIds.includes(t.id),
      caminoHolgura: r.floatPathByTask[t.id] ?? null,
      motivo: motivoDe(r, t.id),
      avance: x.completion ?? 0,
    };
  });
  const inicios = tareas.map((t) => t.inicio).filter(Boolean).sort();
  const fines = tareas.map((t) => t.fin).filter(Boolean).sort();
  return {
    ok: true,
    ciclo: [],
    error: null,
    tareas,
    rutaCritica: r.criticalPath,
    caminosCriticos: r.criticalPaths ?? [],
    inicioProyecto: inicios[0] ?? null,
    finProyecto: fines[fines.length - 1] ?? null,
    restriccionesVioladas: r.violatedConstraintTaskIds,
    fechasLimiteIncumplidas: r.missedDeadlineTaskIds,
    relacionesFueraDeSecuencia: r.outOfSequenceSequenceIds,
    relacionesIgnoradas: r.droppedSequenceIds ?? [],
  };
}

function vacio(error: string, ciclo: string[]): ResultadoProgramacion {
  return {
    ok: false, ciclo, error, tareas: [], rutaCritica: [], caminosCriticos: [], inicioProyecto: null,
    finProyecto: null, restriccionesVioladas: [], fechasLimiteIncumplidas: [], relacionesFueraDeSecuencia: [],
    relacionesIgnoradas: [],
  };
}

const MAX_TAREAS = 50_000;
function validar(m: Modelo): void {
  if (!m || typeof m !== 'object' || !m.proyecto || !Array.isArray(m.tareas) || !Array.isArray(m.relaciones)) {
    throw new ErrorMotor('ENTRADA_INVALIDA', 'Modelo incompleto.');
  }
  if (m.tareas.length > MAX_TAREAS) throw new ErrorMotor('ENTRADA_INVALIDA', `Más de ${MAX_TAREAS} tareas.`);
  if (!/^\d{4}-\d{2}-\d{2}/.test(m.proyecto.inicio ?? '')) {
    throw new ErrorMotor('ENTRADA_INVALIDA', 'La fecha de inicio del proyecto no es válida.');
  }
}

// ---------------------------------------------------------------------------------------------
// Resource leveling

/** Level the renewable resources (equipment, labour, subcontract). Returns per-task delays to store
 *  as `retrasoNivelacionDias` and re-run `programar`. `soloHolgura` keeps the project end fixed. */
export function nivelar(modelo: Modelo, opciones: { soloHolgura?: boolean; recursoIds?: string[] } = {}): ResultadoNivelacion {
  validar(modelo);
  // Leveling starts from no previous delays: it decides them all again.
  const tr = traducir({ ...modelo, tareas: modelo.tareas.map((t) => ({ ...t, retrasoNivelacionDias: null })) });
  tr.tasks = cloneTasksForSolve(tr.tasks);
  const r = resolver(tr, false);
  if (r.error) {
    return { ok: false, error: r.error, retrasos: {}, sinResolver: {}, finAntes: '', finDespues: '', desplazamientos: [] };
  }
  const res = silencioso(() => levelResources(
    tr.tasks, tr.sequences, tr.resources, tr.assignments, tr.calendar, tr.calendars, r,
    { constrainToFloat: !!opciones.soloHolgura, ...(opciones.recursoIds ? { resourceIds: opciones.recursoIds } : {}) },
    { ...solveOptionsFor(tr.project) },
  ));
  return {
    ok: true,
    error: null,
    retrasos: res.delays,
    sinResolver: res.unresolved,
    finAntes: fechaFin(res.projectEndBefore) ?? '',
    finDespues: fechaFin(res.projectEndAfter) ?? '',
    desplazamientos: Object.entries(res.shifts).map(([tareaId, s]) => ({
      tareaId,
      inicioAntes: fecha((s as { oldStart?: string }).oldStart) ?? '',
      inicioDespues: fecha((s as { newStart?: string }).newStart) ?? '',
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Readers

const MAX_BYTES = 50 * 1024 * 1024;
let domListo = false;
function asegurarDom(): void {
  if (domListo) return;
  if (typeof (globalThis as { DOMParser?: unknown }).DOMParser === 'undefined') installXmlDomParser();
  domListo = true;
}

const BINARIOS = /\.(xer|mpp)$/i;
function decodificar(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}

/** Read a P6 (.xer, .xml), MS Project (.xml MSPDI, .mpp) or CSV file. */
export async function leerArchivo(nombre: string, bytes: Uint8Array): Promise<ResultadoLectura> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new ErrorMotor('ENTRADA_INVALIDA', 'Archivo vacío.');
  if (bytes.byteLength > MAX_BYTES) throw new ErrorMotor('ENTRADA_INVALIDA', 'Archivo demasiado grande.');
  const ext = (nombre.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (!['xer', 'mpp', 'xml', 'csv'].includes(ext)) {
    throw new ErrorMotor('FORMATO_DESCONOCIDO', 'Formato no soportado: usa .xer, .xml (P6 o Project), .mpp o .csv.');
  }
  asegurarDom();
  const texto = BINARIOS.test(nombre) ? undefined : decodificar(bytes);
  let formato = ext;
  if (ext === 'xml' && texto !== undefined) formato = detectXmlFlavor(texto) === 'p6' ? 'p6xml' : 'mspdi';
  let abierto;
  try {
    abierto = await silenciosoAsync(() => parseOpenedFile(BINARIOS.test(nombre) ? { name: nombre, bytes } : { name: nombre, text: texto }));
  } catch (e) {
    throw new ErrorMotor('LECTURA_FALLIDA', e instanceof Error ? e.message : String(e));
  }
  const resultados = isMultiDocumentImport(abierto) ? abierto.results : [abierto];
  const proyectos = resultados.map(desdeImport);
  if (!proyectos.some((p) => p.modelo.tareas.length)) throw new ErrorMotor('SIN_TAREAS', 'El archivo no trae tareas.');
  return { formato, proyectos };
}

const OPS_A_RECURSO: Partial<Record<ResourceType, TipoRecurso>> = {
  EQUIPMENT: 'equipo', LABOR: 'dotacion', MATERIAL: 'material', SUBCONTRACTOR: 'subcontrato', CREW: 'dotacion',
};

function desdeCalendario(c: WorkCalendar): MCalendario {
  return {
    original: JSON.stringify(c),
    id: c.id,
    nombre: c.name || c.id,
    diasLaborales: [...c.workDays],
    horasDia: c.hoursPerDay || 8,
    horaInicio: c.workStartHour,
    feriados: (c.holidays ?? []).map((h) => ({ nombre: h.name ?? '', desde: h.startDate, hasta: h.endDate ?? h.startDate })),
    ...(c.workingExceptions?.length
      ? { diasExtra: c.workingExceptions.map((h) => ({ nombre: h.name ?? '', desde: h.startDate, hasta: h.endDate })) }
      : {}),
  };
}

function desdeImport(r: ImportResult): ProyectoLeido {
  const perdidas: string[] = [];
  const calendarios = [r.calendar, ...(r.resourceCalendars ?? [])]
    .filter((c, i, l) => c && l.findIndex((x) => x?.id === c.id) === i)
    .map(desdeCalendario);
  const horasPorCal = new Map(calendarios.map((c) => [c.id, c.horasDia]));
  const orden = new Map(r.tasks.map((t, i) => [t.id, i]));
  const tareas: MTarea[] = r.tasks.map((t) => {
    const x = t.time;
    const horas = horasPorCal.get(t.calendarId ?? r.calendar.id) ?? r.calendar.hoursPerDay ?? 8;
    const dias = diasDeTask(t, horas);
    const resumen = (t.childIds?.length ?? 0) > 0 || t.isSummary === true;
    return {
      id: t.id,
      nombre: t.name,
      parentId: t.parentId ?? null,
      orden: orden.get(t.id) ?? 0,
      wbs: t.wbsCode || null,
      tipo: resumen ? 'resumen' : t.isMilestone ? 'hito' : t.isHammock ? 'hamaca' : 'tarea',
      duracionDias: dias,
      original: JSON.stringify(t),
      inicio: fecha(x.actualStart ?? x.scheduleStart ?? x.earlyStart) ?? r.project.startDate.slice(0, 10),
      restriccion: t.constraint ? { tipo: t.constraint.type, fecha: fecha(t.constraint.date) ?? null } : null,
      fechaLimite: fecha(t.deadline) ?? null,
      calendarioId: t.calendarId ?? null,
      avance: x.completion ?? 0,
      inicioReal: fecha(x.actualStart) ?? null,
      finReal: fecha(x.actualFinish) ?? null,
      retrasoNivelacionDias: t.levelingDelay ?? null,
      idExterno: (t as { p6ActivityId?: string }).p6ActivityId ?? t.wbsCode ?? t.id,
      notas: t.description || null,
    };
  });
  const relaciones: MRelacion[] = r.sequences.map((s) => {
    const horas = r.calendar.hoursPerDay || 8;
    const desfase = s.lagMinutes != null ? s.lagMinutes / 60 / horas : s.lagDays;
    if (s.lagPercent != null) perdidas.push(`Relación con desfase en % convertida a días (${s.id}).`);
    return { id: s.id, predecesoraId: s.predecessorId, sucesoraId: s.successorId, tipo: SEQ_A_TIPO[s.type] ?? 'FS', desfaseDias: Math.round((desfase || 0) * 1000) / 1000, original: JSON.stringify(s) };
  });
  const recursos = r.resources.flatMap((x) => {
    const tipo = OPS_A_RECURSO[x.type];
    if (!tipo) { perdidas.push(`Recurso de costo omitido: ${x.name}.`); return []; }
    return [{ id: x.id, nombre: x.name, tipo, capacidadDia: x.maxUnits ?? 1, unidad: x.unitOfMeasure ?? null, calendarioId: x.calendarId ?? null, original: JSON.stringify(x) }];
  });
  const idsRecursos = new Set(recursos.map((x) => x.id));
  const asignaciones = r.assignments
    .filter((a) => idsRecursos.has(a.resourceId))
    .map((a) => ({ id: a.id, tareaId: a.taskId, recursoId: a.resourceId, unidadesDia: a.unitsPerDay, original: JSON.stringify(a) }));
  const lineasBase = (r.baselines ?? []).map((b) => ({
    id: b.id, nombre: b.name, creadaEn: b.createdAt,
    tareas: b.tasks.map((t) => ({ tareaId: t.taskId, inicio: fecha(t.start)!, fin: fechaFin(t.finish)!, duracionDias: t.duration })),
  }));
  const perfil = (r.project.schedulingProfile?.baseId ?? r.suggestedProfileId ?? 'ops') as Perfil;
  if (r.tasks.some((t) => t.time.durationUnit === 'hours')) perdidas.push('Las duraciones en horas se convirtieron a días.');
  return {
    nombre: r.project.name || 'Proyecto importado',
    perdidas: [...new Set(perdidas)],
    modelo: {
      proyecto: {
        original: JSON.stringify(r.project),
        nombre: r.project.name || 'Proyecto importado',
        inicio: fecha(r.project.startDate) ?? tareas.map((t) => t.inicio).sort()[0] ?? fecha(new Date().toISOString())!,
        fechaEstado: fecha(r.project.statusDate) ?? null,
        perfil: ['ops', 'p6', 'msproject'].includes(perfil) ? perfil : 'ops',
        calendarioId: r.calendar.id,
      },
      tareas,
      relaciones,
      calendarios,
      recursos,
      asignaciones,
      lineasBase,
      lineaBaseActivaId: r.activeBaselineId ?? null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Writers

const PERDIDA_XER: Record<string, string> = {
  taskDescriptions: 'Notas de tareas', baselines: 'Líneas base (P6 las guarda como proyectos aparte)',
  deadlines: 'Fechas límite', levelingDelays: 'Retrasos de nivelación', splits: 'Interrupciones de tareas',
  percentLags: 'Desfases en %', elapsedLags: 'Desfases en tiempo corrido', summaryRelations: 'Relaciones sobre resúmenes',
  summaryAssignments: 'Recursos asignados a resúmenes', summaryConstraints: 'Restricciones en resúmenes',
  truncatedNames: 'Nombres acortados', changedIds: 'Identificadores ajustados al formato de P6',
  nonLatinText: 'Texto fuera de Windows-1252 (archivo en UTF-8)', schedulingRules: 'Reglas de cálculo propias',
  calendarKinds: 'Tipos de calendario', holidayNames: 'Nombres de feriados', priorities: 'Prioridades',
  durationMilestones: 'Hitos con duración', mandatoryMilestones: 'Hitos obligatorios', costResources: 'Recursos de costo',
};

const nombreSeguro = (s: string) => (s || 'carta').replace(/[^\p{L}\p{N} _.-]+/gu, '_').trim().slice(0, 80) || 'carta';

/** Write the model as MS Project XML, P6 XML, XER or CSV. The dates written are the calculated ones. */
export function escribir(modelo: Modelo, formato: FormatoEscritura): ResultadoEscritura {
  return silencioso(() => escribirSinRuido(modelo, formato));
}

function escribirSinRuido(modelo: Modelo, formato: FormatoEscritura): ResultadoEscritura {
  validar(modelo);
  const tr = traducir(modelo);
  tr.tasks = cloneTasksForSolve(tr.tasks);
  const r = resolver(tr, false);
  if (r.error) throw new ErrorMotor('ESCRITURA_FALLIDA', `No se puede calcular la carta: ${r.error}`);
  const base = nombreSeguro(modelo.proyecto.nombre);
  const enc = new TextEncoder();
  const perdidas: string[] = [];
  try {
    switch (formato) {
      case 'mspdi': {
        const { xml, invalidXmlChars } = writeMSPDIWithReport(
          tr.project, tr.calendar, tr.tasks, tr.sequences, tr.resources, tr.assignments, tr.calendars,
          tr.baselines, modelo.lineaBaseActivaId ?? null,
        );
        if (invalidXmlChars) perdidas.push(`${invalidXmlChars} caracteres no válidos en XML se reemplazaron.`);
        return { nombreSugerido: `${base}.xml`, tipoMime: 'application/xml', bytes: enc.encode(xml), perdidas };
      }
      case 'p6xml': {
        const { xml, truncated } = writeP6XMLWithReport(
          tr.project, tr.calendar, tr.tasks, tr.sequences, tr.resources, tr.assignments, tr.calendars,
        );
        if (truncated) perdidas.push(`${truncated} nombres o códigos se acortaron al largo que admite P6.`);
        if (tr.baselines.length) perdidas.push('Las líneas base no se exportan a P6 XML.');
        return { nombreSugerido: `${base}_p6.xml`, tipoMime: 'application/xml', bytes: enc.encode(xml), perdidas };
      }
      case 'xer': {
        const res = writeXER({
          project: tr.project, calendar: tr.calendar, calendars: tr.calendars, tasks: tr.tasks,
          sequences: tr.sequences, resources: tr.resources, assignments: tr.assignments,
          baselineCount: tr.baselines.length,
        });
        for (const l of res.loss) perdidas.push(`${PERDIDA_XER[l.code] ?? l.code} (${l.count})`);
        return { nombreSugerido: `${base}.xer`, tipoMime: 'application/octet-stream', bytes: res.bytes, perdidas };
      }
      case 'csv': {
        const csv = writeCSV(tr.project, tr.calendar, tr.tasks, tr.sequences, tr.resources, tr.assignments);
        return { nombreSugerido: `${base}.csv`, tipoMime: 'text/csv', bytes: enc.encode(csv), perdidas };
      }
      default:
        throw new ErrorMotor('ENTRADA_INVALIDA', `Formato de exportación desconocido: ${String(formato)}`);
    }
  } catch (e) {
    if (e instanceof ErrorMotor) throw e;
    throw new ErrorMotor('ESCRITURA_FALLIDA', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Diagnóstico de fidelidad: calcula el archivo TAL COMO lo leyó OPS (sin pasar
 * por el modelo en días), para comparar con `programar(leerArchivo(...))`.
 */
export async function programarArchivoOriginal(nombre: string, bytes: Uint8Array): Promise<{ fin: string | null; criticas: number; fines: Record<string, string> }> {
  asegurarDom();
  const texto = BINARIOS.test(nombre) ? undefined : decodificar(bytes);
  const abierto = await silenciosoAsync(() => parseOpenedFile(BINARIOS.test(nombre) ? { name: nombre, bytes } : { name: nombre, text: texto }));
  const r0 = isMultiDocumentImport(abierto) ? abierto.results[0] : abierto;
  const tasks = cloneTasksForSolve(r0.tasks);
  const input = solveInputFor(r0.project, tasks, r0.sequences, r0.calendar, [r0.calendar, ...(r0.resourceCalendars ?? [])]);
  const res = silencioso(() => solveProject(input));
  const hojas = tasks.filter((t) => !(t.childIds?.length));
  const fines = Object.fromEntries(hojas.map((t) => [t.name, fechaFin(t.time.actualFinish ?? t.time.earlyFinish) ?? ""]));
  const fs = Object.values(fines).filter(Boolean).sort();
  return { fin: fs[fs.length - 1] ?? null, criticas: hojas.filter((t) => res.tasks.get(t.id)?.isCritical).length, fines };
}
