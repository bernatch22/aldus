/**
 * INSERTAR: paleta → modo colocación (crosshair) → click en la página crea el
 * nodo vía API. Incluye el estilo dominante de la página (el texto nuevo nace
 * pareciéndose a los grafos existentes, no a Helvetica 11) y el área default
 * generosa del texto insertado (se aplica cuando el segmento nuevo aparece en
 * el grafo — match por posición). (v1 COPY; la API llega inyectada.)
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { FIELD_DEFAULT_SIZE, type PageGraph, type WidgetKind } from '@aldus/core';
import type { AldusApi } from '../../core/index.js';
import type { AddTextRequest } from '../boxes/types.js';

const r1 = (v: number) => Math.round(v * 10) / 10;

export type Placing =
  | { kind: 'field'; type: WidgetKind }
  | { kind: 'image'; file: File }
  | { kind: 'text' }
  | null;

export function usePlacement(opts: {
  api: AldusApi;
  id: string;
  pageNum: number;
  graph: PageGraph | null;
  onBumpDoc: () => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onAreaWidth: (segId: string, area: { w?: number; h?: number } | null) => void;
  onSelect: (id: string | null) => void;
  /** Registra la creación en el historial (undo = revert del server). */
  onServerOp: (redo: () => Promise<unknown>) => void;
}) {
  const { api, id, pageNum, graph } = opts;
  const cb = useRef(opts);
  cb.current = opts;

  const [placing, setPlacing] = useState<Placing>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);
  // Texto insertado desde la paleta: se le da un ÁREA por defecto generosa
  // (ancho + alto) para que no nazca "cojo" — se aplica cuando el segmento
  // nuevo aparece en el grafo (match por posición).
  const pendingTextAreaRef = useRef<{ x: number; y: number; area: { w: number; h: number } } | null>(null);

  // El estilo DOMINANTE de la página (mediana de tamaño + bucket más común):
  // el texto nuevo nace pareciéndose a los grafos existentes, no a Helvetica 11.
  const pageTextStyle = useMemo(() => {
    if (!graph?.segments.length) return { size: 11, bucket: 'sans' as const };
    const sizes = graph.segments.map(s => s.fontSize).sort((a, b) => a - b);
    const size = r1(sizes[Math.floor(sizes.length / 2)]!);
    const counts = new Map<string, number>();
    for (const s of graph.segments) {
      const b = s.runs[0]?.font.bucket ?? 'sans';
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    const bucket = ([...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'sans') as 'sans' | 'serif' | 'mono';
    return { size, bucket };
  }, [graph]);

  const onPlace = useCallback((x: number, y: number) => {
    if (!placing) return;
    const p = placing;
    setPlacing(null);
    cb.current.onError('');
    // Un tamaño mínimo cómodo para el texto nuevo (más grande que el default de
    // página si éste es chico) — evita el nodo diminuto.
    const size = p.kind === 'text' ? 12 : pageTextStyle.size;
    if (p.kind === 'text') {
      pendingTextAreaRef.current = { x: r1(x), y: r1(y), area: { w: 240, h: Math.round(size * 1.2 * 2) } };
    }
    const run = (): Promise<unknown> => p.kind === 'field'
      ? api.createField(id, { type: p.type, page: pageNum, x: r1(x), y: r1(y - FIELD_DEFAULT_SIZE[p.type].height) })
      : p.kind === 'image'
        ? api.insertImage(id, p.file, { page: pageNum, x: r1(x), y: r1(y) })
        : api.docOp(id, 'addText', {
            page: pageNum, x: r1(x), y: r1(y),
            text: 'Texto nuevo',
            size, bucket: pageTextStyle.bucket,
          });
    run()
      .then(() => {
        cb.current.onBumpDoc();
        cb.current.onNotice('Creado — doble click para editar');
        cb.current.onServerOp(run); // Ctrl+Z deshace la creación (revert del server)
      })
      .catch(e => { pendingTextAreaRef.current = null; cb.current.onError(e instanceof Error ? e.message : 'No se pudo crear'); });
  }, [placing, api, id, pageNum, pageTextStyle]);

  // Enter en una línea → crea el texto de la línea de abajo (el editor sigue
  // abierto LOCAL sobre la línea nueva, sin depender de que el server responda).
  const onAddText = useCallback((req: AddTextRequest) => {
    const run = () => api.docOp(id, 'addText', { page: req.page, x: r1(req.x), y: r1(req.baseline + req.size), text: req.text, size: req.size, bucket: req.bucket });
    run()
      .then(() => { cb.current.onBumpDoc(); cb.current.onServerOp(run); })
      .catch(e => cb.current.onError(e instanceof Error ? e.message : 'No se pudo agregar'));
  }, [api, id]);

  // Texto recién insertado: aplicarle el área por defecto (match por posición
  // — el server coloca el baseline cerca del click). Llamar cuando aterriza
  // un grafo nuevo.
  const matchInsertedText = useCallback((g: PageGraph) => {
    const pend = pendingTextAreaRef.current;
    if (!pend) return;
    const seg = g.segments.find(s => Math.abs(s.x - pend.x) < 12 && Math.abs(s.baseline - pend.y) < 20 && s.text === 'Texto nuevo');
    if (seg) {
      pendingTextAreaRef.current = null;
      cb.current.onAreaWidth(seg.id, pend.area);
      cb.current.onSelect(seg.id);
    }
  }, []);

  return { placing, setPlacing, imageFileRef, pageTextStyle, onPlace, onAddText, matchInsertedText };
}
