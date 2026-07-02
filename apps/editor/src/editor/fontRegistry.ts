/**
 * Registro PERSISTENTE de fuentes embebidas bajo nombres estables.
 *
 * pdf.js registra cada fuente embebida como FontFace bajo su `loadedName`
 * (p. ej. g_d0_f3) — un id POR DOCUMENTO. El preview crea un documento nuevo
 * por cada edición y destruye el anterior (sus FontFace se desregistran), y un
 * segmento extirpado ya ni siquiera carga su fuente en el doc nuevo. Los
 * fantasmas (segmentos editados, dibujados desde el cache) quedaban huérfanos:
 * el DOM caía al font por defecto — "pierde todos los estilos al soltar" y el
 * letter-spacing se calculaba con la métrica equivocada (deformación).
 *
 * Acá cada fuente embebida se re-registra UNA sola vez por sesión bajo
 * `aldus-<postScriptName>` (estable entre documentos) con sus bytes reales.
 * Necesita `fontExtraProperties: true` en getDocument (pdf.js conserva
 * font.data). styledDom la usa como fallback inmediato del loadedName.
 */
import type { PageGraph } from '@aldus/core';

const registered = new Set<string>();

export const stableFontFamily = (postScriptName: string) =>
  `aldus-${postScriptName.replace(/[^\w-]/g, '_')}`;

/** Re-registra las fuentes embebidas del grafo bajo su nombre estable. */
export function registerPageFonts(
  page: { commonObjs: { get(id: string): unknown } },
  graph: PageGraph,
): void {
  if (typeof FontFace === 'undefined') return; // jsdom/tests
  for (const seg of graph.segments) {
    for (const run of seg.runs) {
      const f = run.font;
      if (!f.embedded || !f.postScriptName) continue;
      const fam = stableFontFamily(f.postScriptName);
      if (registered.has(fam)) continue;
      registered.add(fam); // aunque falle no se reintenta: cae al bucket
      try {
        const obj = page.commonObjs.get(f.loadedName) as { data?: Uint8Array } | null;
        if (!obj?.data) {
          console.warn('[aldus:fonts] SIN BYTES para', f.loadedName, f.postScriptName, '— fantasma caerá al bucket', f.bucket);
          continue;
        }
        const ff = new FontFace(fam, obj.data.slice());
        document.fonts.add(ff);
        void ff.load()
          .then(() => console.log('[aldus:fonts] registrada', fam, '←', f.loadedName))
          .catch(err => { document.fonts.delete(ff); console.warn('[aldus:fonts] load FALLÓ', fam, err); });
      } catch (err) {
        console.warn('[aldus:fonts] commonObjs sin', f.loadedName, '(', f.postScriptName, ')', err);
      }
    }
  }
}
