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

export const createLogger = (namespace: string): Logger =>
  (...args) => {
    if (enabled()) console.log(`[${namespace}]`, ...args);
  };
