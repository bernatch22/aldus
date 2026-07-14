/**
 * helpers.ts — fixtures compartidas de los tests del agente (la red de seguridad
 * F1b portada a v2). Todo determinístico: PDFs reales armados con pdf-lib
 * (como pipeline.test.ts), cero mocks, cero LLM.
 */
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { graphFromBytes } from '../src/graph.js';

export interface FixtureFonts {
  regular: PDFFont;
  bold: PDFFont;
  oblique: PDFFont;
}

/** Construye un PDF de una página con las fuentes estándar ya embebidas. */
export async function pdfWith(
  size: [number, number],
  draw: (page: PDFPage, fonts: FixtureFonts, doc: PDFDocument) => void | Promise<void>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(size);
  const fonts: FixtureFonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    oblique: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  await draw(page, fonts, doc);
  return doc.save();
}

/** Grafo de unos bytes (siempre con slice(): pdf.js TRANSFIERE el buffer). */
export const graphOf = (bytes: Uint8Array) => graphFromBytes(bytes.slice());

export const textOf = (doc: Awaited<ReturnType<typeof graphFromBytes>>) =>
  doc.pages[0]!.segments.map(s => s.text).join(' ');

/**
 * Dump de FILAS al estilo del repro.mts del modo forense: por segmento
 * x/baseline/ancho/texto, y por run x/ancho/gap. Se usa como mensaje de
 * diagnóstico cuando un assert geométrico falla.
 */
export function dumpRows(page: { segments: Array<{ id: string; x: number; baseline: number; width: number; fontSize: number; text: string; runs: Array<{ x: number; width: number; text: string }> }> }): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  const out: string[] = [];
  const rows = [...page.segments].sort((a, b) => b.baseline - a.baseline || a.x - b.x);
  for (const s of rows) {
    out.push(`  ${s.id} @(${r(s.x)},${r(s.baseline)}) w=${r(s.width)} ${r(s.fontSize)}pt: ${JSON.stringify(s.text)}`);
    if (s.runs.length > 1) {
      let prevEnd: number | null = null;
      for (const run of s.runs) {
        const gap = prevEnd != null ? r(run.x - prevEnd) : null;
        const gapTag = gap != null ? (gap < 0 ? ` GAP=${gap} ⚠️SOLAPE` : ` gap=${gap}`) : '';
        out.push(`      run @${r(run.x)} w=${r(run.width)}${gapTag}: ${JSON.stringify(run.text)}`);
        prevEnd = run.x + run.width;
      }
    }
  }
  return out.join('\n');
}
