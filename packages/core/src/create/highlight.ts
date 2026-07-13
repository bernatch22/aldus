/**
 * create/highlight.ts — resaltados NUEVOS + su appearance (VERBATIM v1).
 *
 * Un resaltado es una ANOTACIÓN /Highlight (capa /Annots, no content stream)
 * — así, como widgets/links, sigue siendo seleccionable, movible y borrable
 * después de guardar (y no se quema tapando el texto). Lleva QuadPoints + /C
 * + un appearance stream (blend Multiply, α 0.55) para que los viewers
 * externos lo pinten legible; el editor de Aldus lo dibuja aparte (overlay).
 *
 * {@link highlightAppearance} vive ACÁ como módulo propio (audit: en v1 el
 * bake importaba el look desde createNodes — dependencia invertida): la usan
 * addHighlight (crear) Y HighlightEditApplier (recolorear → regenerar AP).
 */
import { PDFDocument, PDFRef, rgb, type PDFContext } from 'pdf-lib';
import { fmt } from '../common/bytes.js';
import { hexToRgbObj } from '../common/hex.js';
import { appendAnnot } from './registry.js';

const hexToRgbLib = (hex: string) => {
  const c = hexToRgbObj(hex);
  return rgb(c.r, c.g, c.b);
};

/**
 * El appearance stream (Form XObject) de un resaltado en espacio local
 * [0,0,w,h] — el viewer lo escala al /Rect (así move/resize no lo regeneran) —
 * con Multiply para que el texto de arriba siga legible. Fuente ÚNICA del look
 * del highlight. Devuelve el ref del AP y el /C normalizado.
 */
export function highlightAppearance(
  ctx: PDFContext,
  colorHex: string | undefined,
  w: number,
  h: number,
): { apRef: PDFRef; color: [number, number, number] } {
  const c = colorHex ? hexToRgbLib(colorHex) : rgb(1, 0.84, 0); // amarillo marcador
  const gsRef = ctx.register(ctx.obj({ Type: 'ExtGState', BM: 'Multiply', ca: 0.55, CA: 0.55 }));
  const ap = ctx.stream(`/GS gs ${fmt(c.red)} ${fmt(c.green)} ${fmt(c.blue)} rg 0 0 ${fmt(w)} ${fmt(h)} re f`, {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, w, h],
    Resources: ctx.obj({ ExtGState: ctx.obj({ GS: gsRef }) }),
  });
  return { apRef: ctx.register(ap), color: [c.red, c.green, c.blue] };
}

export async function addHighlight(
  pdfBytes: Uint8Array,
  spec: { page: number; x: number; y: number; width: number; height: number; color?: string },
): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);
  const ctx = doc.context;
  const x = spec.x - 1, y = spec.y - 1, w = spec.width + 2, h = spec.height + 2;
  const { apRef, color } = highlightAppearance(ctx, spec.color, w, h);
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [x, y, x + w, y + h],
    // QuadPoints ISO 32000: UL UR LL LR (y crece hacia arriba).
    QuadPoints: [x, y + h, x + w, y + h, x, y, x + w, y],
    C: color,
    CA: 0.55,
    AP: ctx.obj({ N: apRef }),
  });
  appendAnnot(ctx, page, ctx.register(dict));
  return { pdf: await doc.save() };
}
