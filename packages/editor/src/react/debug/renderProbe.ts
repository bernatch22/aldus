/**
 * renderProbe — caja negra del pipeline de render (PdfCanvas).
 *
 * Un tab que MUERE (OOM / render loop) se lleva la consola con él: acá cada
 * checkpoint se escribe SÍNCRONO a localStorage, así el rastro sobrevive al
 * crash. Al montar el editor de nuevo, si la sesión anterior no terminó en
 * `render:done`, se reporta en consola dónde quedó (último paso = el asesino).
 *
 * Siempre graba (es barato: ~10 writes por página); solo HABLA en consola
 * cuando detecta algo (crash previo o loop). Dump manual: `aldusProbe()`.
 */

interface ProbeEntry { t: number; step: string; [k: string]: unknown }

const KEY = 'aldusRenderProbe';
const MAX = 300;

let trail: ProbeEntry[] = [];

/** Detección de loop: N `render:start` de la misma página en una ventana corta. */
const startWindow: number[] = [];
let loopFlagged = false;

function persist(): void {
  try { localStorage.setItem(KEY, JSON.stringify(trail)); } catch { /* quota — el rastro en memoria sigue */ }
}

export function probe(step: string, extra?: Record<string, unknown>): void {
  trail.push({ t: Date.now(), step, ...extra });
  if (trail.length > MAX) trail = trail.slice(-MAX);
  persist();

  if (step === 'render:start') {
    const now = Date.now();
    startWindow.push(now);
    while (startWindow.length && now - startWindow[0]! > 10_000) startWindow.shift();
    if (startWindow.length > 6 && !loopFlagged) {
      loopFlagged = true;
      trail.push({ t: now, step: 'loop:suspect', startsIn10s: startWindow.length });
      persist();
      // eslint-disable-next-line no-console
      console.error(`[aldus:probe] LOOP SOSPECHOSO: ${startWindow.length} render:start en <10s — el effect de PdfCanvas se está re-disparando (¿onGraph inestable?). Rastro: aldusProbe()`);
    }
  }
}

/** Al cargar el módulo: ¿la sesión anterior murió a mitad del pipeline? */
function reportPreviousSession(): void {
  let prev: ProbeEntry[] = [];
  try { prev = JSON.parse(localStorage.getItem(KEY) ?? '[]') as ProbeEntry[]; } catch { prev = []; }
  if (prev.length === 0) return;
  const last = prev[prev.length - 1]!;
  if (last.step !== 'render:done') {
    const tail = prev.slice(-15).map(e => `${new Date(e.t).toISOString().slice(11, 23)} ${e.step} ${JSON.stringify({ ...e, t: undefined, step: undefined })}`);
    // eslint-disable-next-line no-console
    console.warn(`[aldus:probe] La sesión ANTERIOR no llegó a render:done — murió después de "${last.step}". Últimos pasos:\n  ${tail.join('\n  ')}`);
  }
  trail = [];
  persist();
}

declare global { interface Window { aldusProbe?: () => ProbeEntry[] } }
if (typeof window !== 'undefined') {
  reportPreviousSession();
  window.aldusProbe = () => {
    // eslint-disable-next-line no-console
    console.table(trail.map(e => ({ ...e, t: new Date(e.t).toISOString().slice(11, 23) })));
    return trail;
  };
}
