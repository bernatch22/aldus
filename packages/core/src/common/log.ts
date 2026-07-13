/**
 * Tiny debug logger, gated so production output stays silent.
 *
 * Enable with `ALDUS_DEBUG=1` (Node) or `localStorage.aldusDebug = '1'`
 * (browser). Every debug line in the repo goes through here — never a raw
 * `console.log` in production paths.
 */
export type Logger = (...args: unknown[]) => void;

const enabled = (): boolean => {
  try {
    if (typeof process !== 'undefined' && process.env?.ALDUS_DEBUG) return true;
  } catch {
    /* no process (browser) */
  }
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('aldusDebug')) return true;
  } catch {
    /* no localStorage (Node / sandboxed iframe) */
  }
  return false;
};

/** Trace ring buffer — el modo forense (🐞) lo vuelca en el bundle de /tmp.
 *  TODO log gateado que pasa por createLogger queda grabado acá (últimos 800):
 *  la "grabación de sesión" sale gratis, sin instrumentación extra. */
export interface TraceEvent { t: number; ns: string; msg: string }
const TRACE_MAX = 800;
const traceBuf: TraceEvent[] = [];

const fmt = (a: unknown): string => {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
};

/** Registra un evento en el trace (aunque el log a consola esté apagado). */
export const traceEvent = (ns: string, ...args: unknown[]): void => {
  traceBuf.push({ t: Date.now(), ns, msg: args.map(fmt).join(' ') });
  if (traceBuf.length > TRACE_MAX) traceBuf.splice(0, traceBuf.length - TRACE_MAX);
};

/** El trace acumulado (para el bundle forense). */
export const getTrace = (): TraceEvent[] => [...traceBuf];

export const createLogger = (namespace: string): Logger =>
  (...args) => {
    traceEvent(namespace, ...args);
    if (enabled()) console.log(`[${namespace}]`, ...args);
  };
