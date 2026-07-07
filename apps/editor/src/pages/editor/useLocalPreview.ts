import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import {
  effectiveGeometry, mergeImageEdit, segmentOriginal,
  type ImageEdit, type ImageNode, type PageGraph, type SegmentEdit, type SegmentNode, type WidgetEdit,
} from '@aldus/core';
import { api } from '../../lib/api';
import type { PendingHighlight } from './usePendingEdits';

/**
 * PREVIEW HORNEADO LOCALMENTE: las ediciones pendientes se aplican EN EL
 * BROWSER (el mismo bake de core, import dinámico) sobre una copia de los
 * bytes base, y se renderiza ESO. WYSIWYG real, sin máscaras ni duplicados;
 * el server no se toca hasta Aplicar.
 *
 * ⚠️ INVARIANTE: el effect del preview NO puede depender de `graph` ni de
 * funciones que lo capturen — meter `graph` en la cadena de deps causaba un
 * loop de re-render (render → extract → grafo nuevo → effect → render…) =
 * pantalla parpadeando. Todo lo que necesita el grafo lo lee por refs.
 */
export function useLocalPreview(opts: {
  id: string;
  docVersion: number;
  edits: Map<string, SegmentEdit>;
  imageEdits: Map<string, ImageEdit>;
  widgetEdits: Map<string, WidgetEdit>;
  pendingHighlights: PendingHighlight[];
  editsRef: MutableRefObject<Map<string, SegmentEdit>>;
  highlightsRef: MutableRefObject<PendingHighlight[]>;
  graphRef: MutableRefObject<PageGraph | null>;
  segCache: MutableRefObject<Map<string, SegmentNode>>;
  onError: (message: string) => void;
}) {
  const { id, docVersion, edits, imageEdits, widgetEdits, pendingHighlights, editsRef, highlightsRef, graphRef, segCache } = opts;
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [baseBytes, setBaseBytes] = useState<Uint8Array | null>(null);

  // Precalentar el chunk del bake (pdf-lib es pesado): sin esto, la PRIMERA
  // edición paga el import dinámico y el preview extirpador tarda ~1s en
  // llegar — se veía el texto "duplicado" hasta entonces.
  useEffect(() => { void import('@aldus/core/bake'); }, []);

  // Los BYTES base del documento (lo que el server tiene persistido).
  useEffect(() => {
    let cancelled = false;
    fetch(`${api.pdfUrl(id)}?v=${docVersion}`)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then(buf => { if (!cancelled) setBaseBytes(new Uint8Array(buf)); })
      .catch(e => { if (!cancelled) onErrorRef.current(e instanceof Error ? e.message : 'No se pudo abrir el PDF'); });
    return () => { cancelled = true; };
  }, [id, docVersion]);

  // Un highlight atado a un segmento SIGUE al texto: su rect se resuelve
  // contra la geometría efectiva (con la edición pendiente aplicada).
  // ⚠️ Un segmento con edición pendiente está EXTIRPADO del grafo del preview
  // — vive en segCache (fantasmas). Sin el fallback al cache, resaltar y
  // después mover dejaba el resaltado huérfano en la posición vieja ("queda
  // una capa"). Mismo fallback que findSeg.
  // IDENTIDAD ESTABLE (lee por refs): jamás va en deps de effects.
  const resolveHighlights = useCallback((): PendingHighlight[] => {
    const g = graphRef.current;
    return highlightsRef.current.map(h => {
      if (!h.segmentId) return h;
      const seg = (g && g.page === h.page ? g.segments.find(s => s.id === h.segmentId) : undefined)
        ?? segCache.current.get(h.segmentId);
      if (!seg) return h;
      const eff = effectiveGeometry(seg, editsRef.current.get(seg.id) ?? null);
      return { ...h, x: eff.x, y: eff.y, width: eff.width, height: eff.height };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hornear los BYTES del preview: base + ediciones pendientes (texto editado
  // EXTIRPADO — el overlay lo dibuja como fantasma) + imágenes + campos +
  // highlights. `extraRemoval` extirpa además un segmento SIN edición (el
  // lift del que está por arrastrarse).
  const bakePending = useCallback(async (extraRemoval?: SegmentNode, extraImageRemoval?: ImageNode): Promise<Uint8Array> => {
    if (!baseBytes) throw new Error('documento no cargado');
    const { bakeSegmentEdits, addHighlight } = await import('@aldus/core/bake');
    const textRemovals: SegmentEdit[] = [...edits.values()].map(e => ({
      segmentId: e.segmentId, page: e.page, text: e.original.text, remove: true, original: e.original,
    }));
    if (extraRemoval && !edits.has(extraRemoval.id)) {
      textRemovals.push({ segmentId: extraRemoval.id, page: extraRemoval.page, text: extraRemoval.text, remove: true, original: segmentOriginal(extraRemoval) });
    }
    // LIFT de imagen: hornear la página SIN esa imagen (removida), para que al
    // arrastrarla el canvas muestre lo que hay detrás (no un velo blanco).
    // Reemplaza cualquier edición previa de esa imagen por un remove.
    let imgEditList = [...imageEdits.values()];
    if (extraImageRemoval) {
      const rm = mergeImageEdit(extraImageRemoval, null, { remove: true });
      if (rm) imgEditList = [...imgEditList.filter(e => e.imageId !== extraImageRemoval.id), rm];
    }
    const r = await bakeSegmentEdits(baseBytes.slice(), textRemovals, imgEditList, [...widgetEdits.values()]);
    // Color EXACTO del content stream → sobreescribe el muestreado en el cache
    // de fantasmas (el fantasma se ve idéntico al original, sin aproximación).
    for (const [segId, hex] of Object.entries(r.colors)) {
      const s = segCache.current.get(segId);
      if (s) s.runs.forEach(run => { run.color = hex; });
    }
    let bytes = r.pdf;
    for (const h of resolveHighlights()) ({ pdf: bytes } = await addHighlight(bytes, h));
    return bytes;
    // resolveHighlights es estable (lee refs) — NUNCA va en deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseBytes, edits, imageEdits, widgetEdits]);

  const pending = edits.size || imageEdits.size || widgetEdits.size || pendingHighlights.length;
  useEffect(() => {
    if (!baseBytes) return;
    let cancelled = false;
    // El re-bake corre YA (sin debounce): un solo drop/commit necesita
    // extirpar el original cuanto antes (debouncearlo prolongaba el
    // "duplicado" sobre imágenes). El lift cubre el gesto; el bake refina.
    (async () => {
      const bytes = pending ? await bakePending() : baseBytes;
      if (cancelled) return;
      // pdf.js TRANSFIERE el buffer al worker → siempre una copia.
      // fontExtraProperties: el fontRegistry necesita font.data para
      // re-registrar las embebidas bajo nombres estables.
      const doc = await getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
      if (cancelled) { void doc.destroy(); return; }
      setPdf(prev => { void prev?.destroy(); return doc; });
    })().catch(e => { if (!cancelled) onErrorRef.current(e instanceof Error ? e.message : 'No se pudo generar el preview'); });
    return () => { cancelled = true; };
  }, [baseBytes, bakePending, pending, edits, imageEdits, widgetEdits, pendingHighlights]);

  return { pdf, baseBytes, bakePending, resolveHighlights };
}
