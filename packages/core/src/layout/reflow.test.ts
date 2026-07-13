/**
 * reflow.test.ts — el motor de reflow determinístico (F4), portado de los casos
 * 6–8 de v1 (agent/test/reflow.test.ts) y ADAPTADO a la API de core: reflowApply
 * es una función pura + un seam `reExtract`, no un método de EditSession.
 *
 * El seam se cablea a la PROPIA cadena de core: bake (F3) → extractPageGraph (F2),
 * sobre PDFs fixture de pdf-lib. El `ReflowEnv` es un harness mínimo (Map de
 * segment-edits + cola de creates + bake) — el gemelo de lo que F5 implementará
 * sobre el EditLedger.
 *
 *  6. abort+restore: texto que NO entra ni comprimiendo → aborta y NO toca nada.
 *  7. replaceParagraph que ACHICA → menos líneas y el inferior SUBE (múltiplo del leading).
 *  8. editText que agrega renglones → nada pasa del margen derecho, gaps respetados,
 *     inferior corrido (defensas #11–#14).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  applyTextDiff, originalStyledRuns, mergeSegmentEdit, paragraphOf, paragraphToks, reflowApply,
  type AnyEdit, type PageGraph, type ReflowCreate, type ReflowEnv, type SegmentEdit, type SegmentNode,
} from '../index.js';
import { addFormField, addText, bake } from '../bake/index.js';
import { graphOf } from '../../test/helpers.js';

/** ReflowEnv de test: Map de segment-edits + creates + bake(core) + reExtract. */
class Harness implements ReflowEnv {
  edits = new Map<string, SegmentEdit>();
  creates: ReflowCreate[] = [];
  constructor(private readonly bytes: Uint8Array) {}
  effBaseline(seg: SegmentNode): number { return this.edits.get(seg.id)?.baseline ?? seg.baseline; }
  isRemoved(id: string): boolean { return this.edits.get(id)?.remove === true; }
  putSeg(seg: SegmentNode, patch: Parameters<typeof mergeSegmentEdit>[2]): void {
    const m = mergeSegmentEdit(seg, this.edits.get(seg.id) ?? null, patch);
    if (m) this.edits.set(seg.id, m); else this.edits.delete(seg.id);
  }
  deleteSeg(id: string): void { this.edits.delete(id); }
  snapshotSegments(): ReadonlyMap<string, SegmentEdit> { return new Map(this.edits); }
  restoreSegments(snap: ReadonlyMap<string, SegmentEdit>): void { this.edits = new Map(snap); }
  async bake(): Promise<Uint8Array> {
    const edits = [...this.edits.values()].map(e => ({ kind: 'segment', ...e }) as AnyEdit);
    let { pdf } = await bake(this.bytes.slice(), edits);
    for (const c of this.creates) {
      if (c.kind === 'text') pdf = (await addText(pdf, { page: c.page!, x: c.x!, y: c.y!, text: c.text!, size: c.size })).pdf;
      else if (c.kind === 'field') pdf = (await addFormField(pdf, { type: 'text', page: c.page!, x: c.x!, y: c.y!, width: c.width as number, height: c.height as number, name: c.name as string })).pdf;
    }
    return pdf;
  }
}

const reExtract = async (bytes: Uint8Array): Promise<PageGraph[]> => [await graphOf(bytes)];

async function replaceParagraph(h: Harness, g: PageGraph, s: SegmentNode, text: string) {
  const para = paragraphOf(g, s, h);
  const avgCharW = s.width / Math.max(1, s.text.length);
  const toks = [...text.matchAll(/\S+/g)].map(m => ({ kind: 'word' as const, text: m[0], w: m[0].length * avgCharW, bold: false, italic: false }));
  return reflowApply(s, para, toks, h, reExtract);
}
async function editText(h: Harness, g: PageGraph, s: SegmentNode, text: string) {
  const para = paragraphOf(g, s, h);
  const avgCharW = s.width / Math.max(1, s.text.length);
  const styled = applyTextDiff(originalStyledRuns(s), text);
  const toks = paragraphToks(para, [], { lineId: s.id, styled, avgCharW });
  return reflowApply(s, para, toks, h, reExtract);
}

const dumpRows = (page: PageGraph): string =>
  [...page.segments].sort((a, b) => b.baseline - a.baseline || a.x - b.x)
    .map(s => `  ${s.id} @(${Math.round(s.x)},${Math.round(s.baseline)}) w=${Math.round(s.width)}: ${JSON.stringify(s.text)}`).join('\n');

const PARA = [
  'El presente contrato se celebra entre las partes con el objeto de',
  'regular la prestación de servicios profesionales, incluyendo el',
  'alcance de las tareas, los plazos de entrega acordados y la forma',
  'de pago pactada entre ambas partes contratantes del servicio.',
];

const paraPdf = async (opts: { bottomAt?: number } = {}): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500, 700]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  let y = 600;
  for (const line of PARA) { page.drawText(line, { x: 60, y, size: 11, font: f }); y -= 14; }
  page.drawText('Cláusula segunda: la vigencia del acuerdo será de un año.', { x: 60, y: y - 30, size: 11, font: f });
  page.drawText('Firmas de las partes al pie del documento presente.', { x: 60, y: y - 44, size: 11, font: f });
  if (opts.bottomAt != null) page.drawText('Texto que llena el resto de la página hasta el fondo.', { x: 60, y: opts.bottomAt, size: 11, font: f });
  return doc.save();
};

describe('reflow de párrafo (determinístico, bake+medición real)', () => {
  it('6. NO entra ni comprimiendo → aborta y NO toca nada', async () => {
    const bytes = await paraPdf({ bottomAt: 60 });
    const g = await graphOf(bytes);
    const before = g.segments.map(s => `${s.text}@${Math.round(s.baseline)}`).join('|');
    const h = new Harness(bytes);
    const first = g.segments.find(s => s.text.startsWith('El presente'))!;
    const long = 'Este texto nuevo es muchísimo más largo que el párrafo original y pretende ocupar una cantidad de renglones que la página, que ya está completamente llena hasta el margen inferior, no puede alojar de ninguna manera razonable. '.repeat(4);

    const res = await replaceParagraph(h, g, first, long);
    expect(res.aborted).toBe(true);
    // Abort+restore: el env quedó VACÍO (ley: lo que no puede hacer bien, no lo toca).
    expect(h.edits.size).toBe(0);
    expect(h.creates.length).toBe(0);
    const re = await graphOf(await h.bake());
    expect(re.segments.map(s => `${s.text}@${Math.round(s.baseline)}`).join('|')).toBe(before);
  }, 60_000);

  it('7. replaceParagraph que ACHICA → menos líneas y el inferior SUBE', async () => {
    const bytes = await paraPdf();
    const g = await graphOf(bytes);
    const h = new Harness(bytes);
    const first = g.segments.find(s => s.text.startsWith('El presente'))!;
    const belowBefore = g.segments.find(s => s.text.startsWith('Cláusula'))!.baseline; // 514

    const res = await replaceParagraph(h, g, first, 'Contrato breve de servicios entre las partes.');
    expect(res.aborted).toBeFalsy();
    expect(res.freedLines).toBeGreaterThan(0);

    const re = await graphOf(await h.bake());
    const paraLines = re.segments.filter(s => s.baseline > 550);
    expect(paraLines.length).toBeLessThan(PARA.length); // el párrafo se achicó
    const belowAfter = re.segments.find(s => s.text.startsWith('Cláusula'))!;
    expect(belowAfter.baseline).toBeGreaterThan(belowBefore + 10); // subió a cerrar el hueco
    const dy = belowAfter.baseline - belowBefore;
    expect(Math.abs(dy % 14)).toBeLessThanOrEqual(1); // múltiplo del leading 14 ±1
  }, 60_000);

  it('8. editText que agrega renglones → nada pasa del margen, gaps respetados, inferior corrido', async () => {
    const bytes = await paraPdf();
    const g = await graphOf(bytes);
    const rightEdge = Math.max(...g.segments.filter(s => s.baseline > 530).map(s => s.x + s.width));
    const belowBefore = g.segments.find(s => s.text.startsWith('Cláusula'))!.baseline;
    const paraZone = (gr: PageGraph) => gr.segments.filter(s => s.baseline > 480 && s.x >= 55);
    const spaceW = 11 * 0.28;

    const h = new Harness(bytes);
    const last = g.segments.find(s => s.text.startsWith('de pago'))!;
    const res = await editText(h, g, last,
      'de pago pactada entre ambas partes contratantes del servicio, incluyendo además los intereses moratorios aplicables, las penalidades por incumplimiento y el mecanismo de resolución de controversias acordado.');
    expect(res.aborted).toBeFalsy();
    expect(res.extraLines).toBeGreaterThan(0);

    const re = await graphOf(await h.bake());
    const dump = dumpRows(re);

    // (a) NINGÚN run se pasa del borde derecho original (+3pt como el motor).
    for (const s of re.segments.filter(x => x.baseline > 400)) {
      for (const run of s.runs) {
        expect(run.x + run.width, `run "${run.text.slice(0, 30)}" se pasa del borde\n${dump}`).toBeLessThanOrEqual(rightEdge + 3);
      }
    }
    // (b) gaps mínimos: dentro de cada fila, ningún par de runs se pisa.
    const rows = new Map<number, Array<{ x: number; width: number; text: string }>>();
    for (const s of re.segments.filter(x => x.baseline > 400 && x.x >= 55)) {
      const key = Math.round(s.baseline);
      const row = rows.get(key) ?? [];
      row.push(...s.runs);
      rows.set(key, row);
    }
    for (const [, runs] of rows) {
      const flat = [...runs].sort((a, b) => a.x - b.x);
      for (let i = 1; i < flat.length; i++) {
        const gap = flat[i]!.x - (flat[i - 1]!.x + flat[i - 1]!.width);
        expect(gap, `gap entre "${flat[i - 1]!.text.slice(0, 20)}" y "${flat[i]!.text.slice(0, 20)}"\n${dump}`).toBeGreaterThanOrEqual(spaceW * 0.7 - 0.5);
      }
    }
    // (c) el contenido inferior BAJÓ una cantidad entera de renglones.
    const belowAfter = re.segments.find(s => s.text.startsWith('Cláusula'))!;
    expect(belowAfter.baseline).toBeLessThan(belowBefore - 10);
    expect(Math.abs((belowBefore - belowAfter.baseline) % 14)).toBeLessThanOrEqual(1);
    // (d) el párrafo ganó renglones.
    expect(paraZone(re).length).toBeGreaterThan(paraZone(g).length);
  }, 60_000);
});
