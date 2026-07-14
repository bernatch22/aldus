/**
 * PdfCanvas — renderiza UNA página a canvas (nítido en HiDPI) y extrae su grafo.
 *
 * Orden importante: primero el render a canvas (pdf.js registra ahí las fuentes
 * embebidas como FontFace bajo su loadedName), después extractPageGraph — así el
 * overlay ya puede usar esas familias y dibujar con los glifos REALES del PDF.
 * El ORDEN grafo-antes-que-snapshot es un INVARIANTE (ver comentario abajo).
 *
 * v2: consume los SERVICIOS del composition root — `FontRegistryService`
 * (fuentes estables), `ColorSampler` (Map puro de colores, el caller lo aplica),
 * `ImagePixelCache` (píxeles limpios). El double-buffer/lift-blit conserva el
 * ALGORITMO de v1 VERBATIM (liftShownRef/liftHoldRef/draggingRef — audit §4
 * riesgo 2); el lift llega como prop `lift` (derivado de LiftService por el
 * composition root) y `draggingId` como estado del gesto.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { extractPageGraph, type PageGraph, type PdfJsPage } from '@aldus/core';
import {
  runKey,
  type ColorSampler,
  type FontRegistryService,
  type ImagePixelCache,
} from '../core/index.js';
import { probe } from './debug/renderProbe.js';

export interface PdfCanvasServices {
  fonts: FontRegistryService;
  colors: ColorSampler;
  pixels: ImagePixelCache;
}

interface Props {
  pdf: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  services: PdfCanvasServices;
  onGraph: (g: PageGraph) => void;
  /** Página pre-horneada SIN el nodo seleccionado (lista para blitear). */
  lift: { segId: string; doc: PDFDocumentProxy } | null;
  /** Nodo en arrastre (si coincide con el lift, se blitea su buffer). */
  draggingId: string | null;
  /** El overlay (NodeOverlay + capa del host), renderizado por el caller con
   *  el snapshot/imagePixels que este canvas produce. */
  children: (out: {
    snapshot: { url: string; width: number; height: number } | null;
    imagePixels: Map<string, string>;
  }) => ReactNode;
}

/** Renderiza una página de pdf.js en un canvas offscreen (HiDPI). */
async function renderToBackBuffer(doc: PDFDocumentProxy, pageNum: number, scale: number, taskRef: { current: RenderTask | null }): Promise<HTMLCanvasElement | null> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  const back = document.createElement('canvas');
  back.width = Math.floor(viewport.width * dpr);
  back.height = Math.floor(viewport.height * dpr);
  // Un canvas desmedido (scale/dpr corrupto) mata el tab en la alocación misma.
  probe('render:alloc', { page: pageNum, scale, dpr, w: back.width, h: back.height });
  // willReadFrequently: el muestreo de color lee el canvas con getImageData —
  // sin esta bandera el browser avisa y la lectura es más lenta.
  const ctx = back.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  taskRef.current?.cancel();
  const task = page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    // annotationMode por DEFAULT (ENABLE): los widgets, links y cualquier
    // anotación exótica preexistente (ink/stamp/notas) SÍ se pintan en el
    // canvas — el snapshot de drags depende de eso. Los /Highlight NO se
    // duplican con el HighlightBox porque el preview los oculta con el flag
    // Hidden (ver hideHighlightAnnotations en PreviewService).
  });
  taskRef.current = task;
  try {
    await task.promise;
  } catch {
    return null; // cancelado por un render más nuevo
  }
  return back;
}

export function PdfCanvas({ pdf, pageNum, scale, services, onGraph, lift, draggingId, children }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const liftTaskRef = useRef<RenderTask | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // Snapshot de la página renderizada: los previews de imágenes movidas lo usan
  // como fuente de píxeles (crop por background-position).
  const [snapshot, setSnapshot] = useState<{ url: string; width: number; height: number } | null>(null);
  // Píxeles REALES de cada imagen (con transparencia), para un ghost sin halo.
  const [imagePixels, setImagePixels] = useState<Map<string, string>>(new Map());

  // DOUBLE BUFFER + LIFT (así lo hace el annotation editor de pdf.js: el canvas
  // no se toca durante un gesto). `mainBack` = último render del preview;
  // `liftBack` = la página sin el segmento seleccionado, pre-renderizada. El
  // visible SOLO recibe drawImage atómicos — nunca se limpia ni renderiza
  // en vivo, así ningún update se ve como un "refresh".
  const mainBackRef = useRef<HTMLCanvasElement | null>(null);
  const liftBackRef = useRef<{ segId: string; canvas: HTMLCanvasElement } | null>(null);
  const liftShownRef = useRef(false);
  const draggingRef = useRef<string | null>(null);
  draggingRef.current = draggingId;
  // "Sostener el lift": desde que arranca el drag hasta que el re-bake aterriza
  // (incluye el post-drop). Sin esto, un drag rápido (lift aún no listo) dejaba
  // el original visible bajo el movido hasta el re-bake.
  const liftHoldRef = useRef(false);

  const blit = (src: HTMLCanvasElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== src.width || canvas.height !== src.height) {
      canvas.width = src.width;
      canvas.height = src.height;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${Math.floor(src.width / dpr)}px`;
    canvas.style.height = `${Math.floor(src.height / dpr)}px`;
    canvas.getContext('2d')?.drawImage(src, 0, 0);
  };

  // Render principal: preview → back buffer → blit → snapshot + grafo.
  useEffect(() => {
    let cancelled = false;
    probe('render:start', { page: pageNum, scale });
    (async () => {
      const back = await renderToBackBuffer(pdf, pageNum, scale, renderTaskRef);
      if (cancelled || !back) return;
      probe('render:backbuffer', { page: pageNum });
      const dpr = window.devicePixelRatio || 1;
      const w = Math.floor(back.width / dpr);
      const h = Math.floor(back.height / dpr);
      mainBackRef.current = back;
      blit(back);
      liftShownRef.current = false; // el preview manda: el lift quedó atrás
      liftHoldRef.current = false;  // el re-bake aterrizó: se suelta el lift
      setSize({ w, h });
      const page = await pdf.getPage(pageNum);
      probe('extract:start', { page: pageNum });
      const g = await extractPageGraph(page as unknown as PdfJsPage);
      if (cancelled) return;
      probe('extract:done', { page: pageNum, runs: g.runs.length, segs: g.segments.length, imgs: g.images.length, shapes: g.shapes.length });
      // Las fuentes embebidas, bajo nombres ESTABLES (sobreviven al destroy
      // del documento — los fantasmas dependen de esto).
      try { services.fonts.registerPageFonts(page as unknown as { commonObjs: { get(id: string): unknown } }, g); } catch { /* best-effort */ }
      probe('fonts:done', { page: pageNum });
      // Color de cada run: cache primero (barato), muestreo solo lo que falta.
      // v2: el sampler es PURO (devuelve un Map, no muta nada) — ESTE es el
      // ÚNICO sitio que aplica la capa de color al grafo recién extraído,
      // antes de publicarlo (audit §4 riesgo 4: un solo escritor explícito;
      // el color EXACTO del bake pisa después el cache de fantasmas).
      try {
        const colors = services.colors.sample(g, back, scale);
        for (const run of g.runs) {
          const hex = colors.get(runKey(g.page, run));
          if (hex) run.color = hex;
        }
      } catch { /* best-effort */ }
      probe('colors:done', { page: pageNum });
      // Píxeles limpios de las imágenes (para el ghost de arrastre sin fondo).
      try { setImagePixels(services.pixels.extract(page as unknown as { objs: { has(o: string): boolean; get(o: string): unknown } }, g.images)); } catch { /* best-effort */ }
      probe('pixels:done', { page: pageNum });
      // ORDEN: el GRAFO (que define movePending del ghost de imagen) se
      // actualiza JUNTO/ANTES que el snapshot. Si el snapshot se actualizaba
      // primero, había un frame con snapshot NUEVO (imagen ya movida) + grafo
      // VIEJO (movePending true) → el ghost recortaba la posición vieja del
      // snapshot nuevo = VACÍO → "la imagen se perdía".
      onGraph(g);
      probe('graph:set', { page: pageNum });
      try {
        setSnapshot({ url: back.toDataURL('image/jpeg', 0.7), width: w, height: h });
      } catch {
        setSnapshot(null);
      }
      probe('render:done', { page: pageNum });
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdf, pageNum, scale, onGraph, services]);

  // Render del LIFT (en background, mientras el usuario todavía no arrastra).
  // Nada de snapshot/grafo acá: es solo un buffer listo para blitear.
  useEffect(() => {
    if (!lift) {
      // Lift cancelado (drop no-op): si estaba en pantalla, restaurar el preview.
      if (liftShownRef.current && mainBackRef.current) {
        blit(mainBackRef.current);
        liftShownRef.current = false;
      }
      liftBackRef.current = null;
      return;
    }
    // Un lift NUEVO para un segmento que NO se está arrastrando = select fresco
    // → no sostener (no ocultar ese segmento por un hold viejo).
    if (draggingRef.current !== lift.segId) liftHoldRef.current = false;
    let cancelled = false;
    (async () => {
      const back = await renderToBackBuffer(lift.doc, pageNum, scale, liftTaskRef);
      if (cancelled || !back) return;
      liftBackRef.current = { segId: lift.segId, canvas: back };
      // El drag ya arrancó (o el drop está pendiente): blitear ya mismo para
      // tapar el original hasta que el re-bake aterrice.
      if (draggingRef.current === lift.segId || liftHoldRef.current) {
        blit(back);
        liftShownRef.current = true;
      }
    })().catch(() => { /* doc del lift destruido a mitad de render — irrelevante */ });
    return () => {
      cancelled = true;
      liftTaskRef.current?.cancel();
    };
  }, [lift, pageNum, scale]);

  // Arrancó el arrastre → sostener el lift y blitear instantáneo (si ya está
  // listo). El hold sigue tras el drop hasta que el re-bake aterrice.
  useEffect(() => {
    if (!draggingId) return;
    liftHoldRef.current = true;
    const lb = liftBackRef.current;
    if (lb && lb.segId === draggingId && !liftShownRef.current) {
      blit(lb.canvas);
      liftShownRef.current = true;
    }
  }, [draggingId]);

  return (
    <div className="pdf-stage" style={size ? { width: size.w, height: size.h } : undefined}>
      <canvas ref={canvasRef} />
      {children({ snapshot, imagePixels })}
    </div>
  );
}
