/**
 * pageGraphService — índices reconstruidos tras replace(), la proyección a
 * buckets de segmentsAt con los casos borde 0.549/0.551×fs (bucket±1 es
 * OBLIGATORIO: la proyección discretiza un umbral continuo), byGeometry con
 * la tolerancia nombrada, byNormalizedText y locateText encima del service.
 */
import { describe, expect, it } from 'vitest';
import type { ImageNode, PageGraph, SegmentNode, TextRunNode } from '../model/nodes.js';
import { locateText } from './locateText.js';
import { PageGraphService } from './pageGraphService.js';

const TR = (text: string, x: number, baseline: number, fontSize = 9.75): TextRunNode =>
  ({ id: `p1-r-${x}-${baseline}`, kind: 'text', page: 1, text, x, baseline, width: text.length * fontSize * 0.5, fontSize, angle: 0, font: { bold: false, italic: false, ascent: 0.8, descent: -0.2 } as TextRunNode['font'] });

const SEG = (id: string, page: number, text: string, x: number, baseline: number, fontSize = 9.75): SegmentNode => ({
  id, kind: 'segment', page, text,
  runs: [TR(text, x, baseline, fontSize)],
  x, baseline,
  width: text.length * fontSize * 0.5,
  y: baseline - 0.2 * fontSize,
  height: fontSize,
  fontSize,
});

const IMG = (id: string, page: number, x: number, y: number, w: number, h: number): ImageNode =>
  ({ id, kind: 'image', page, x, y, width: w, height: h, rotated: false });

const GRAPH = (page: number, segments: SegmentNode[], images: ImageNode[] = []): PageGraph => ({
  page, width: 612, height: 792,
  runs: segments.flatMap(s => s.runs),
  lines: [], segments, images, widgets: [], links: [], highlights: [], shapes: [],
});

describe('PageGraphService', () => {
  it('byId indexa todos los kinds y replace() purga los ids viejos', () => {
    const svc = new PageGraphService();
    const seg = SEG('p1-y700-x72', 1, 'Alpha', 72, 700);
    const img = IMG('p1-img_a', 1, 10, 10, 50, 50);
    svc.replace(GRAPH(1, [seg], [img]));

    expect(svc.byId('p1-y700-x72')).toBe(seg);
    expect(svc.byId('p1-img_a')).toBe(img);
    expect(svc.byId(seg.runs[0]!.id)).toBe(seg.runs[0]);

    // Re-extract: el grafo nuevo REEMPLAZA — los ids que ya no existen mueren.
    const seg2 = SEG('p1-y650-x72', 1, 'Beta', 72, 650);
    svc.replace(GRAPH(1, [seg2]));
    expect(svc.byId('p1-y700-x72')).toBeUndefined();
    expect(svc.byId('p1-img_a')).toBeUndefined();
    expect(svc.byId('p1-y650-x72')).toBe(seg2);
  });

  it('onDidReplace se dispara con el grafo nuevo', () => {
    const svc = new PageGraphService();
    const fired: number[] = [];
    svc.onDidReplace(g => fired.push(g.page));
    svc.replace(GRAPH(1, []));
    svc.replace(GRAPH(2, []));
    expect(fired).toEqual([1, 2]);
  });

  describe('segmentsAt — umbral 0.55×fs con bucket±1', () => {
    const fs = 9.75;
    const svc = new PageGraphService();
    const body = SEG('p1-y100-x10', 1, 'cuerpo', 10, 100, fs);
    svc.replace(GRAPH(1, [body]));

    it('a 0.549×fs de distancia: MISMA línea (lo encuentra aunque caiga en el bucket vecino)', () => {
      const hits = svc.segmentsAt(1, 100 - 0.549 * fs, fs);
      expect(hits).toContain(body);
    });

    it('a 0.551×fs de distancia: línea distinta (excluido por el filtro exacto)', () => {
      expect(svc.segmentsAt(1, 100 - 0.551 * fs, fs)).toHaveLength(0);
      expect(svc.segmentsAt(1, 100 + 0.551 * fs, fs)).toHaveLength(0);
    });

    it('en la baseline exacta se encuentra a sí mismo', () => {
      expect(svc.segmentsAt(1, 100, fs)).toEqual([body]);
    });

    it('replace() invalida los buckets (no hay índice fantasma)', () => {
      const svc2 = new PageGraphService();
      svc2.replace(GRAPH(1, [SEG('p1-y100-x10', 1, 'viejo', 10, 100, fs)]));
      svc2.segmentsAt(1, 100, fs); // construye el bucket
      const nuevo = SEG('p1-y200-x10', 1, 'nuevo', 10, 200, fs);
      svc2.replace(GRAPH(1, [nuevo]));
      expect(svc2.segmentsAt(1, 100, fs)).toHaveLength(0);
      expect(svc2.segmentsAt(1, 200, fs)).toEqual([nuevo]);
    });
  });

  it('byGeometry matchea dentro de la tolerancia (~1.8pt) y rechaza afuera', () => {
    const svc = new PageGraphService();
    const img = IMG('p1-img_a', 1, 100, 200, 80, 60);
    svc.replace(GRAPH(1, [], [img]));
    expect(svc.byGeometry(1, { x: 101, y: 199, width: 80.5, height: 60 })).toEqual([img]);
    expect(svc.byGeometry(1, { x: 105, y: 200, width: 80, height: 60 })).toEqual([]);
    // tol explícita más generosa
    expect(svc.byGeometry(1, { x: 105, y: 200, width: 80, height: 60 }, 6)).toEqual([img]);
  });

  it('byNormalizedText: case/acentos/espacios normalizados, texto del grafo intacto', () => {
    const svc = new PageGraphService();
    const seg = SEG('p1-y700-x72', 1, 'PARTE  RECEPTORA: Ramón', 72, 700);
    svc.replace(GRAPH(1, [seg]));
    expect(svc.byNormalizedText('parte receptora')).toEqual([seg]);
    expect(svc.byNormalizedText('ramon')).toEqual([seg]);
    expect(svc.byNormalizedText('inexistente')).toEqual([]);
    // El nodo NO fue normalizado in-place.
    expect(seg.text).toBe('PARTE  RECEPTORA: Ramón');
  });

  it('locateText sobre el service: pageHint primero; shortest DENTRO de la primera página con hits (semántica v1)', () => {
    const svc = new PageGraphService();
    svc.replace(GRAPH(1, [
      SEG('p1-y700-x72', 1, 'Contrato de arrendamiento firmado', 72, 700),
      SEG('p1-y600-x72', 1, 'Firmado y sellado', 72, 600),
    ]));
    svc.replace(GRAPH(2, [SEG('p2-y700-x72', 2, 'Firmado', 72, 700)]));

    // Sin hint: la PRIMERA página con hits gana; dentro de ella, el segmento
    // más corto que contiene el needle (el ancla más apretada).
    expect(locateText(svc, 'firmado')?.segmentId).toBe('p1-y600-x72');
    // pageHint reordena: la página 2 va primero.
    expect(locateText(svc, 'firmado', { pageHint: 2 })?.segmentId).toBe('p2-y700-x72');
    // prefer 'first': orden de lectura (arriba hacia abajo) dentro de la página.
    expect(locateText(svc, 'firmado', { prefer: 'first' })?.segmentId).toBe('p1-y700-x72');
    // sin match → null, nunca adivinar.
    expect(locateText(svc, 'zzz')).toBeNull();
  });
});
