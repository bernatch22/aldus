/**
 * placeholderMatch.test.ts — el matching PURO de placeholders_to_fields (F4):
 * leader elástico + expansión + colocación directa, flex multi-línea con guion
 * de corte Word, barrido de huérfanos, y el guardrail XXXX. Todo sin EditSession
 * (función pura sobre ParaLine[]).
 *
 * TODO(F5): los tests de placeholders VÍA EditSession (guardrail que rechaza
 * edit_text, idempotencia por segunda llamada, roundtrip bake → widget real)
 * quedan para F5, cuando la fachada exista. Ver v1 agent/test/placeholders.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { matchPlaceholders, looksLikeLeaderRewrite } from './placeholderMatch.js';
import { paragraphOf, type LayoutEnv, type ParaLine } from './paragraph.js';
import type { PageGraph, SegmentNode } from '../model/nodes.js';
import { graphOf } from '../../test/helpers.js';

const ENV: LayoutEnv = { effBaseline: s => s.baseline, isRemoved: () => false };
const linesOf = (g: PageGraph, seg: SegmentNode): ParaLine[] => paragraphOf(g, seg, ENV).lines;
const ctxFor = (seg: SegmentNode) => ({ page: 1, fontSize: seg.fontSize, existingWidgets: [], queuedFields: [] });

const draw = async (fn: (page: import('pdf-lib').PDFPage, f: PDFFont) => void): Promise<PageGraph> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500, 400]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  fn(page, f);
  return graphOf(await doc.save());
};

describe('matchPlaceholders — colocación directa por charX', () => {
  it('leader elástico + expansión: 5 puntos pasados → campo sobre el run REAL', async () => {
    const g = await draw(p => p.drawText('NOMBRE: ..............................', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('NOMBRE'))!;

    const res = matchPlaceholders(linesOf(g, seg), [{ placeholder: '.....', name: 'nombre' }], ctxFor(seg));
    expect(res.error).toBeUndefined();
    expect(res.fields).toHaveLength(1);
    const field = res.fields[0]!;
    expect(field.name).toBe('nombre');

    const lib = await PDFDocument.create();
    const helv = await lib.embedFont(StandardFonts.Helvetica);
    const trueX0 = 60 + helv.widthOfTextAtSize('NOMBRE: ', 11);
    const trueW = helv.widthOfTextAtSize('.'.repeat(30), 11);
    // charXOf estima por pesos de clase de glifo → tolerancia holgada (±5pt).
    expect(Math.abs(field.x - trueX0)).toBeLessThanOrEqual(5);
    expect(Math.abs(field.width - trueW)).toBeLessThanOrEqual(5);
  });

  it('barrido: DOS runs de leaders, se pasa UNO → se crean DOS campos', async () => {
    const g = await draw(p => p.drawText('Fecha: .............. Lugar: ..............', { x: 60, y: 280, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('Fecha'))!;

    const res = matchPlaceholders(linesOf(g, seg), [{ placeholder: '.....', name: 'fecha' }], ctxFor(seg));
    expect(res.fields).toHaveLength(2);
    const byX = [...res.fields].sort((a, b) => a.x - b.x);
    expect(byX[0]!.name).toBe('fecha');        // el nombrado por el LLM
    expect(byX[1]!.name).toMatch(/^campo_/);   // el huérfano, auto-nombrado
  });

  it('flex multi-línea "..... [company legal name]" con guion Word → UN campo, label dropped', async () => {
    const g = await draw(p => {
      p.drawText('entered into by and between ........................... [company le-', { x: 60, y: 300, size: 10 });
      p.drawText('gal name], a company duly incorporated under the laws.', { x: 60, y: 287, size: 10 });
    });
    const seg = g.segments.find(s => s.text.includes('between'))!;

    const res = matchPlaceholders(
      linesOf(g, seg),
      [{ placeholder: '..... [company legal name]', name: 'company_legal_name' }],
      ctxFor(seg),
    );
    expect(res.fields).toHaveLength(1); // UN solo match — el label no genera un 2do campo
    const field = res.fields[0]!;
    expect(field.name).toBe('company_legal_name');
    // El campo cae en la LÍNEA del run largo de leaders (la primera, baseline 300).
    expect(Math.abs(field.y - (300 - 2))).toBeLessThanOrEqual(1);
    const lib = await PDFDocument.create();
    const helv = await lib.embedFont(StandardFonts.Helvetica);
    const trueX0 = 60 + helv.widthOfTextAtSize('entered into by and between ', 10);
    expect(Math.abs(field.x - trueX0)).toBeLessThanOrEqual(10);
  });

  it('placeholder no encontrado → error, cero campos', async () => {
    const g = await draw(p => p.drawText('NOMBRE: ..............', { x: 60, y: 300, size: 11 }));
    const seg = g.segments[0]!;
    const res = matchPlaceholders(linesOf(g, seg), [{ placeholder: 'INEXISTENTE', name: 'x' }], ctxFor(seg));
    expect(res.error).toBeDefined();
    expect(res.fields).toHaveLength(0);
  });

  it('idempotencia por overlap: el rect ya ocupado se saltea (nothingNew)', async () => {
    const g = await draw(p => p.drawText('NOMBRE: ..............................', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('NOMBRE'))!;
    // Primera pasada para saber dónde cae el campo.
    const first = matchPlaceholders(linesOf(g, seg), [{ placeholder: '.....', name: 'nombre' }], ctxFor(seg));
    const placed = first.fields[0]!;
    // Segunda pasada con ese rect ya en `queuedFields` → salteado.
    const res = matchPlaceholders(
      linesOf(g, seg),
      [{ placeholder: '.....', name: 'nombre' }],
      { page: 1, fontSize: seg.fontSize, existingWidgets: [], queuedFields: [{ x: placed.x, y: placed.y, width: placed.width }] },
    );
    expect(res.fields).toHaveLength(0);
    expect(res.nothingNew).toBe(true);
  });
});

describe('looksLikeLeaderRewrite — guardrail XXXX (def #1)', () => {
  it('reescribir leaders con relleno → true; texto normal → false', () => {
    expect(looksLikeLeaderRewrite('NOMBRE: ..............', 'NOMBRE: Juan Pérez')).toBe(true);
    expect(looksLikeLeaderRewrite('Fecha: ____________', 'Fecha: 01/01')).toBe(true);
    expect(looksLikeLeaderRewrite('Cliente Acme', 'Cliente Beta')).toBe(false); // sin leaders, no aplica
    expect(looksLikeLeaderRewrite('DATE: ......', 'DATE: ......')).toBe(false);  // sigue con leaders, ok
  });
});
