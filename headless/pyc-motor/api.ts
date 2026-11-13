// Public contract of the `pyc-motor` package: the scheduling core of Open Planner Studio (CPM,
// resource levelling, P6/MS Project/CSV readers and writers) behind a small, plain-JSON model.
// Built by scripts/build-pyc-motor.mjs. This file imports nothing: it is the whole public type surface.
//
// Model conventions
// - Dates are ISO date strings (`YYYY-MM-DD`); scheduling runs in day mode.
// - Durations and lags are working days on the task calendar (fractions allowed).
// - Ids are opaque strings chosen by the caller and returned unchanged.

export type TipoTarea = 'tarea' | 'resumen' | 'hito' | 'hamaca';
export type TipoRelacion = 'FS' | 'SS' | 'FF' | 'SF';
export type TipoRestriccion = 'ASAP' | 'ALAP' | 'SNET' | 'SNLT' | 'FNET' | 'FNLT' | 'MSO' | 'MFO';
export type Perfil = 'ops' | 'p6' | 'msproject';
export type TipoRecurso = 'equipo' | 'dotacion' | 'material' | 'subcontrato';
export type FormatoEscritura = 'mspdi' | 'p6xml' | 'xer' | 'csv';

export interface MProyecto {
  nombre: string;
  /** Project start (lower bound for tasks with predecessors). */
  inicio: string;
  /** Status / data date. */
  fechaEstado?: string | null;
  perfil: Perfil;
  /** Id of the project calendar inside `calendarios`. */
  calendarioId: string;
  /** Near-critical threshold in working days; absent = off. */
  umbralCasiCritica?: number | null;
  /** Number of float paths to compute (0/absent = off). */
  caminosHolgura?: number | null;
  /** Fidelity: the element exactly as read from the file (JSON, opaque). The motor starts from it and
   *  overrides only what the model changed, so P6/MSP data (hours, remaining work, types) survive. */
  original?: string | null;
}

export interface MFeriado { nombre: string; desde: string; hasta: string }

export interface MCalendario {
  id: string;
  nombre: string;
  /** ISO weekdays 1 (Monday) … 7 (Sunday). */
  diasLaborales: number[];
  horasDia: number;
  /** Hour the working day starts (0–23). Default 8 (0 when horasDia = 24). */
  horaInicio?: number;
  feriados: MFeriado[];
  /** Days that become working days (e.g. a Saturday shift). */
  diasExtra?: MFeriado[];
  /** Fidelity: the element exactly as read from the file (JSON, opaque). The motor starts from it and
   *  overrides only what the model changed, so P6/MSP data (hours, remaining work, types) survive. */
  original?: string | null;
}

export interface MRestriccion { tipo: TipoRestriccion; fecha?: string | null }

export interface MTarea {
  id: string;
  nombre: string;
  parentId: string | null;
  /** Display order among siblings (ascending). */
  orden: number;
  wbs?: string | null;
  tipo: TipoTarea;
  duracionDias: number;
  /** Planned start; for a task without predecessors it is its anchor. */
  inicio: string;
  restriccion?: MRestriccion | null;
  fechaLimite?: string | null;
  calendarioId?: string | null;
  /** 0–1. */
  avance: number;
  inicioReal?: string | null;
  finReal?: string | null;
  /** Levelling delay in working days (written back by `nivelar`). */
  retrasoNivelacionDias?: number | null;
  /** External identifier from the imported file (P6 activity id / MSP UID), kept for round trips. */
  idExterno?: string | null;
  /**
   * What-if multiplier on the task's REMAINING work (1 = unchanged, 1.25 = remaining lasts 25 % longer).
   * Applied on top of the remaining duration the task really has — for an imported task, the file's own
   * remaining (P6 remaining duration, MSP remaining work) — so done work, hours and progress survive.
   * Finished tasks are not touched; the remaining is capped at MAX_REMAINING_DAYS working days.
   */
  factorRestante?: number | null;
  notas?: string | null;
  /** Fidelity: the element exactly as read from the file (JSON, opaque). The motor starts from it and
   *  overrides only what the model changed, so P6/MSP data (hours, remaining work, types) survive. */
  original?: string | null;
}

export interface MRelacion {
  id: string;
  predecesoraId: string;
  sucesoraId: string;
  tipo: TipoRelacion;
  desfaseDias: number;
  /** Fidelity: the element exactly as read from the file (JSON, opaque). The motor starts from it and
   *  overrides only what the model changed, so P6/MSP data (hours, remaining work, types) survive. */
  original?: string | null;
}

export interface MRecurso {
  id: string;
  nombre: string;
  tipo: TipoRecurso;
  /** Units available per working day (1 = one unit at 100 %). */
  capacidadDia: number;
  unidad?: string | null;
  calendarioId?: string | null;
  /** Fidelity: the element exactly as read from the file (JSON, opaque). The motor starts from it and
   *  overrides only what the model changed, so P6/MSP data (hours, remaining work, types) survive. */
  original?: string | null;
}

export interface MAsignacion {
  id: string;
  tareaId: string;
  recursoId: string;
  unidadesDia: number;
  /** Fidelity: the element exactly as read from the file (JSON, opaque). The motor starts from it and
   *  overrides only what the model changed, so P6/MSP data (hours, remaining work, types) survive. */
  original?: string | null;
}

export interface MLineaBase {
  id: string;
  nombre: string;
  creadaEn: string;
  tareas: { tareaId: string; inicio: string; fin: string; duracionDias: number }[];
}

export interface Modelo {
  proyecto: MProyecto;
  tareas: MTarea[];
  relaciones: MRelacion[];
  calendarios: MCalendario[];
  recursos: MRecurso[];
  asignaciones: MAsignacion[];
  lineasBase?: MLineaBase[];
  lineaBaseActivaId?: string | null;
}

export type MotivoFecha =
  | { tipo: 'relacion'; predecesoras: string[] }
  | { tipo: 'restriccion' | 'inicioPropio' | 'inicioProyecto' | 'fechaEstado' | 'nivelacion' | 'avance' | 'otro' };

export interface ResultadoTarea {
  id: string;
  inicio: string;
  fin: string;
  inicioTemprano: string;
  finTemprano: string;
  inicioTardio: string;
  finTardio: string;
  holguraTotal: number;
  holguraLibre: number;
  critica: boolean;
  casiCritica: boolean;
  caminoHolgura: number | null;
  motivo: MotivoFecha | null;
  /** Rolled-up progress for summaries; the task's own for leaves (0–1). */
  avance: number;
}

export interface ResultadoProgramacion {
  ok: boolean;
  /** Task ids in a dependency cycle (when `ok` is false because of a cycle). */
  ciclo: string[];
  error: string | null;
  tareas: ResultadoTarea[];
  rutaCritica: string[];
  caminosCriticos: string[][];
  inicioProyecto: string | null;
  finProyecto: string | null;
  restriccionesVioladas: string[];
  fechasLimiteIncumplidas: string[];
  relacionesFueraDeSecuencia: string[];
  relacionesIgnoradas: string[];
}

export interface ResultadoNivelacion {
  ok: boolean;
  error: string | null;
  /** taskId → levelling delay in working days. */
  retrasos: Record<string, number>;
  /** taskId → conflicting days that could not be solved. */
  sinResolver: Record<string, string[]>;
  finAntes: string;
  finDespues: string;
  desplazamientos: { tareaId: string; inicioAntes: string; inicioDespues: string }[];
  /** Constraints and deadlines that leveling made a task break although it met them before (its own delay
   *  or a predecessor's pushed it past the limit). Leveling first tries to delay ANOTHER task instead, and
   *  never moves a MSO/MFO task; what is listed here had no way out. Empty = nothing new is broken. */
  avisos: AvisoNivelacion[];
}

export interface AvisoNivelacion {
  tareaId: string;
  /** `restriccion` = SNLT/FNLT/MSO/MFO no longer met; `fechaLimite` = the task's deadline is now missed. */
  tipo: 'restriccion' | 'fechaLimite';
}

export interface ProyectoLeido {
  nombre: string;
  modelo: Modelo;
  /** Human-readable notes about data the reader could not carry over. */
  perdidas: string[];
}

export interface ResultadoLectura {
  formato: string;
  proyectos: ProyectoLeido[];
}

export interface ResultadoEscritura {
  nombreSugerido: string;
  tipoMime: string;
  bytes: Uint8Array;
  perdidas: string[];
}

export type CodigoErrorMotor = 'ENTRADA_INVALIDA' | 'FORMATO_DESCONOCIDO' | 'LECTURA_FALLIDA' | 'ESCRITURA_FALLIDA' | 'SIN_TAREAS';
