/**
 * text/fontRegistry.ts — registro PERSISTENTE de fuentes embebidas bajo
 * nombres estables (v1: `apps/editor/src/editor/fontRegistry.ts`).
 *
 * pdf.js registra cada fuente embebida como FontFace bajo su `loadedName`
 * (p. ej. g_d0_f3) — un id POR DOCUMENTO. El preview crea un documento nuevo
 * por cada edición y destruye el anterior (sus FontFace se desregistran), y un
 * segmento extirpado ya ni siquiera carga su fuente en el doc nuevo. Los
 * fantasmas (segmentos editados, dibujados desde el cache) quedaban huérfanos:
 * el DOM caía al font por defecto — "pierde todos los estilos al soltar" y el
 * letter-spacing se calculaba con la métrica equivocada (deformación).
 *
 * Acá cada fuente embebida se re-registra UNA sola vez bajo
 * `aldus-<postScriptName>` (estable entre documentos) con sus bytes reales.
 * Necesita `fontExtraProperties: true` en getDocument (pdf.js conserva
 * font.data). styledDom la usa como fallback inmediato del loadedName.
 *
 * AJUSTE v2 (audit §2 COPY-CON-AJUSTES): el `Set` global de módulo de v1 pasa
 * a ser un SERVICIO con lifetime propio — `dispose()` remueve las FontFace que
 * este registro agregó (una lib embebida varias veces en la misma página no
 * debe acumular fuentes de sesiones anteriores). El nombre estable sigue
 * siendo determinístico (no depende de la instancia), así que dos instancias
 * concurrentes que registran la MISMA fuente no chocan (el registro es
 * idempotente por nombre real de `document.fonts`, no solo por el Set local).
 */
import { createLogger, type IDisposable, type PageGraph } from '@aldus/core';

const log = createLogger('aldus:fonts');

export const stableFontFamily = (postScriptName: string): string =>
  `aldus-${postScriptName.replace(/[^\w-]/g, '_')}`;

/** Página mínima que necesita el registro (subset de PDFPageProxy). */
export interface FontSourcePage {
  commonObjs: { get(id: string): unknown };
}

export class FontRegistryService implements IDisposable {
  private readonly registered = new Set<string>();
  private readonly ownedFaces: FontFace[] = [];
  private disposed = false;

  /** Re-registra las fuentes embebidas del grafo bajo su nombre estable. */
  registerPageFonts(page: FontSourcePage, graph: PageGraph): void {
    if (this.disposed || typeof FontFace === 'undefined') return; // jsdom/tests
    for (const seg of graph.segments) {
      for (const run of seg.runs) {
        const f = run.font;
        if (!f.embedded || !f.postScriptName) continue;
        const fam = stableFontFamily(f.postScriptName);
        if (this.registered.has(fam)) continue;
        this.registered.add(fam); // aunque falle no se reintenta: cae al bucket
        try {
          const obj = page.commonObjs.get(f.loadedName) as { data?: Uint8Array } | null;
          if (!obj?.data) {
            log('SIN BYTES para', f.loadedName, f.postScriptName, '— fantasma caerá al bucket', f.bucket);
            continue;
          }
          const ff = new FontFace(fam, obj.data.slice());
          this.ownedFaces.push(ff);
          document.fonts.add(ff);
          void ff.load()
            .then(() => log('registrada', fam, '←', f.loadedName))
            .catch(err => { document.fonts.delete(ff); log('load FALLÓ', fam, err); });
        } catch (err) {
          log('commonObjs sin', f.loadedName, '(', f.postScriptName, ')', err);
        }
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ff of this.ownedFaces.splice(0)) document.fonts.delete(ff);
    this.registered.clear();
  }
}
