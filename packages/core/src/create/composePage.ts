/**
 * create/composePage.ts — COMPONER una página desde bloques estructurados.
 * La pieza "diseño" del agente: el LLM describe QUÉ va en la página (título,
 * encabezados, párrafos, viñetas — contenido estructurado); este módulo hace
 * TODO el layout determinístico: tipografía por tipo de bloque, wrap por
 * medición REAL de la fuente (pdf-lib widthOfTextAtSize), interlineado,
 * espaciados y márgenes. El LLM nunca calcula coordenadas.
 *
 * Devuelve NewTextSpec[] (los mismos creates de addText — al hornear, pdf-lib
 * respeta los '\n' pre-wrapeados con el mismo lineHeight 1.35 de addText).
 */
import { PDFDocument } from 'pdf-lib';
import type { FontBucket } from '../model/nodes.js';
import { stdFontFor } from '../bake/fonts/fontService.js';
import type { NewTextSpec } from './text.js';

export interface PageBlock {
  /** Tipo tipográfico: define tamaño/peso/espaciado por convención. */
  type: 'title' | 'heading' | 'subheading' | 'paragraph' | 'bullet' | 'spacer';
  /** El contenido (vacío para spacer). */
  text?: string;
  /** Overrides opcionales. */
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: 'left' | 'center';
}

/** Tipografía por tipo (tamaño pt, bold, espacio antes/después en pt). */
const TYPO: Record<Exclude<PageBlock['type'], 'spacer'>, { size: number; bold: boolean; before: number; after: number }> = {
  title: { size: 18, bold: true, before: 0, after: 16 },
  heading: { size: 14, bold: true, before: 14, after: 8 },
  subheading: { size: 12, bold: true, before: 10, after: 6 },
  paragraph: { size: 11, bold: false, before: 0, after: 9 },
  bullet: { size: 11, bold: false, before: 0, after: 4 },
};

const MARGIN = 72;           // 1" — márgenes de composición
const LINE_FACTOR = 1.35;    // MISMO leading que create/text.ts addText

export interface ComposeResult {
  specs: NewTextSpec[];
  /** Bloques que NO entraron en la página (el layout es honesto: no encoge). */
  truncated: string[];
  lines: number;
}

/**
 * Layout de los bloques en una página (pageW×pageH en puntos PDF). Wrap por
 * palabra con el ancho REAL de la fuente estándar correspondiente.
 */
export async function composePageBlocks(
  blocks: PageBlock[],
  pageW: number,
  pageH: number,
  bucket: FontBucket = 'serif',
): Promise<ComposeResult> {
  // Fuentes de MEDICIÓN (doc temporal — solo para widthOfTextAtSize).
  const meas = await PDFDocument.create();
  const fonts = {
    regular: await meas.embedFont(stdFontFor(bucket, false, false)),
    bold: await meas.embedFont(stdFontFor(bucket, true, false)),
    italic: await meas.embedFont(stdFontFor(bucket, false, true)),
  };

  const colW = pageW - MARGIN * 2;
  const specs: NewTextSpec[] = [];
  const truncated: string[] = [];
  let y = pageH - MARGIN; // borde superior del próximo bloque
  let totalLines = 0;

  const wrap = (text: string, size: number, bold: boolean, italic: boolean, width: number): string[] => {
    const font = bold ? fonts.bold : italic ? fonts.italic : fonts.regular;
    const out: string[] = [];
    for (const hard of text.split('\n')) {
      const words = hard.split(/\s+/).filter(Boolean);
      let line = '';
      for (const w of words) {
        const cand = line ? `${line} ${w}` : w;
        if (line && font.widthOfTextAtSize(cand, size) > width) { out.push(line); line = w; }
        else line = cand;
      }
      out.push(line);
    }
    return out.length ? out : [''];
  };

  for (const b of blocks) {
    if (b.type === 'spacer') { y -= 12; continue; }
    const t = TYPO[b.type];
    const size = t.size;
    const bold = b.bold ?? t.bold;
    const italic = b.italic ?? false;
    const prefix = b.type === 'bullet' ? '•  ' : '';
    const indent = b.type === 'bullet' ? 14 : 0;
    const lines = wrap(prefix + (b.text ?? ''), size, bold, italic, colW - indent);
    const lineH = size * LINE_FACTOR;
    const blockH = lines.length * lineH;

    y -= t.before;
    if (y - blockH < MARGIN) { truncated.push(`${b.type}: "${(b.text ?? '').slice(0, 40)}…"`); continue; }

    // Centrado: solo tiene sentido en una línea (título); multi-línea cae a izquierda.
    let x = MARGIN + indent;
    if (b.align === 'center' && lines.length === 1) {
      const font = bold ? fonts.bold : italic ? fonts.italic : fonts.regular;
      x = Math.max(MARGIN, (pageW - font.widthOfTextAtSize(lines[0]!, size)) / 2);
    }

    specs.push({
      page: 0, // el caller la fija
      x, y,
      text: lines.join('\n'),
      size, bucket, bold, italic,
      ...(b.color ? { color: b.color } : {}),
    });
    totalLines += lines.length;
    y -= blockH + t.after;
  }

  return { specs, truncated, lines: totalLines };
}
