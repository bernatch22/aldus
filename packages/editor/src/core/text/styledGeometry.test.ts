import { describe, expect, it } from 'vitest';
import {
  originalStyledRuns,
  styledText,
  toggleStyleRange,
  type FontInfo,
  type SegmentNode,
  type StyledRun,
  type TextRunNode,
} from '@aldus/core';
import { restyleFromGraph } from './styledGeometry.js';

/**
 * El caso REAL del contrato LibreOffice (doc 33fbf521, nodo p1-y595-x85):
 * glifos sin /ToUnicode (U+0011), 3 líneas, itálicas. Las x/w son las del
 * grafo real (log CLICK del usuario). El bug: el commit recalculaba los dx
 * midiendo con el CANVAS del browser ("denominación" bold midió 83.2pt; el
 * bake la dibuja en 71.2pt) → agujeros → el re-extract PARTÍA el nodo.
 * restyleFromGraph debe devolver los dx REALES del PDF, no los del browser.
 */
const font = (italic = false): FontInfo => ({
  loadedName: 'g_d0_f1',
  postScriptName: 'Liberation-Serif',
  bold: false,
  italic,
  bucket: 'serif',
  ascent: 0.75,
  descent: -0.25,
  embedded: true,
});

let seq = 0;
const run = (text: string, x: number, width: number, baseline: number, italic = false, extra: Partial<TextRunNode> = {}): TextRunNode => ({
  id: `r${seq++}`,
  kind: 'text',
  page: 1,
  text,
  x,
  baseline,
  width,
  fontSize: 11.3,
  angle: 0,
  font: font(italic),
  ...extra,
});

const C = String.fromCharCode(0x11); // el control char de los acentos LibreOffice sin /ToUnicode

function makeSeg(): SegmentNode {
  const runs = [
    // L0 (baseline 594.8)
    run('……………………. [', 85.1, 75.1, 594.8),
    run('denominación social de la empresa', 160.1, 160.3, 594.8, true),
    run('], con domicilio en ………………… [', 320.1, 153.0, 594.8),
    run('dirección,', 472.9, 44.6, 594.8, true),
    // L1 (baseline 581.4) — dos runs con U+0011; gaps de 1.4-1.5pt = espacio
    // comprimido (>0.12×fs), como en el doc real.
    run('ciudad y país', 85.1, 64.8, 581.4, true),
    run('] y n', 149.8, 25.4, 581.4),
    run(`ú${C}`, 175.1, 4.6, 581.4),
    run('mero de identificaci', 181.2, 98.5, 581.4),
    run(`o${C}`, 279.6, 4.4, 581.4),
    run('n/registro fiscal ........................,', 285.4, 139.8, 581.4),
    run('representada por', 426.7, 84.5, 581.4),
    // L2 (baseline 568.0)
    run('.............................................................. [', 85.1, 146.7, 568.0),
    run('nombre y apellidos, cargo', 231.8, 117.9, 568.0, true),
    run('] (en adelante, la "Empresa"),', 349.5, 137.6, 568.0),
  ];
  const seg: SegmentNode = {
    id: 'p1-y595-x85',
    kind: 'segment',
    page: 1,
    text: '', // lo fija originalStyledRuns/el ensamblado — abajo
    runs,
    x: 85.1,
    baseline: 594.8,
    width: 432.4,
    y: 565.2,
    height: 32.4,
    fontSize: 11.3,
  };
  seg.text = styledText(originalStyledRuns(seg));
  return seg;
}

describe('restyleFromGraph', () => {
  it('(a) bold a "denominación" → el run siguiente a la itálica arranca en dx REAL 235, no el browser 255.3', () => {
    const seg = makeSeg();
    let styled = originalStyledRuns(seg);
    const at = seg.text.indexOf('denominación');
    styled = toggleStyleRange(styled, at, at + 'denominación'.length, 'bold');
    const out = restyleFromGraph(seg, styled)!;
    expect(out).not.toBeNull();
    // "denominación" quedó bold+italic, anclada en su x real (160.1 − 85.1).
    const den = out.find(r => r.text.startsWith('denominación'))!;
    expect(den.bold).toBe(true);
    expect(den.italic).toBe(true);
    expect(den.dx).toBe(75);
    // El graph-run siguiente arranca EXACTO en su x del PDF: 320.1 − 85.1 = 235
    // (la medición browser daba 255.3 → agujero de 14pt → nodo partido).
    const dom = out.find(r => r.text.startsWith('], con domicilio'))!;
    expect(dom.dx).toBe(235);
    // La frontera de estilo a mitad del run itálico interpola ENTRE los bordes.
    const social = out.find(r => r.text === ' social de la empresa')!;
    expect(social.dx).toBeGreaterThan(75);
    expect(social.dx).toBeLessThan(235);
    expect(social.italic).toBe(true);
    expect(social.bold).toBe(false);
  });

  it('(b) ningún run cruza \\n — el \\n va pegado al final del último run de su línea', () => {
    const seg = makeSeg();
    const out = restyleFromGraph(seg, originalStyledRuns(seg))!;
    expect(out).not.toBeNull();
    for (const r of out) {
      const inner = r.text.slice(0, -1);
      expect(inner.includes('\n')).toBe(false);
    }
    expect(out.filter(r => r.text.endsWith('\n'))).toHaveLength(2); // 3 líneas → 2 saltos
  });

  it('(c) el primer run de cada línea lleva el dx de su x real', () => {
    const seg = makeSeg();
    const out = restyleFromGraph(seg, originalStyledRuns(seg))!;
    // Offsets de inicio de línea sobre el texto de salida:
    let offset = 0;
    const lineStartDx: number[] = [];
    let lineStart = true;
    for (const r of out) {
      if (lineStart) lineStartDx.push(r.dx);
      lineStart = r.text.endsWith('\n');
      offset += r.text.length;
    }
    // Las 3 líneas arrancan en x=85.1 = seg.x → dx 0.
    expect(lineStartDx).toEqual([0, 0, 0]);
    // Y todos los dx son finitos (jamás NaN hacia el bake).
    for (const r of out) expect(Number.isFinite(r.dx)).toBe(true);
  });

  it('(d) texto total idéntico al ensamblado del grafo', () => {
    const seg = makeSeg();
    let styled = originalStyledRuns(seg);
    const at = seg.text.indexOf('dirección');
    styled = toggleStyleRange(styled, at, at + 'dirección'.length, 'bold');
    const out = restyleFromGraph(seg, styled)!;
    expect(styledText(out)).toBe(seg.text);
    expect(styledText(out)).toBe(styledText(styled));
  });

  it('(e) styled con texto desalineado → null (defensivo: cae a applyAlign)', () => {
    const seg = makeSeg();
    const styled: StyledRun[] = [{ text: 'otro texto cualquiera', bold: false, italic: false, dx: 0 }];
    expect(restyleFromGraph(seg, styled)).toBeNull();
    // También un desvío de UN carácter (p. ej. trailing space recortado):
    const casi = originalStyledRuns(seg);
    casi[casi.length - 1]!.text = casi[casi.length - 1]!.text.slice(0, -1);
    expect(restyleFromGraph(seg, casi)).toBeNull();
  });

  it('underline conserva el ancho geométrico del grafo cuando el tramo coincide con un run subrayado', () => {
    const seg = makeSeg();
    // Marcar "ciudad y país" como subrayado REAL en el grafo:
    const target = seg.runs.find(r => r.text === 'ciudad y país')!;
    target.underline = true;
    let styled = originalStyledRuns(seg);
    const at = seg.text.indexOf('ciudad y país');
    styled = toggleStyleRange(styled, at, at + 'ciudad y país'.length, 'bold');
    const out = restyleFromGraph(seg, styled)!;
    const ciudad = out.find(r => r.text === 'ciudad y país')!;
    expect(ciudad.underline).toBe(true);
    expect(ciudad.bold).toBe(true);
    expect(ciudad.dx).toBe(0); // anclado en la x real del run (85.1 − seg.x)
    // Ancho GEOMÉTRICO del PDF (cx: del inicio del run al inicio del
    // siguiente, 149.8 − 85.1 = 64.7 ≈ width real 64.8), no el del browser.
    expect(Math.abs((ciudad.w ?? 0) - 64.8)).toBeLessThan(0.2);
  });
});
