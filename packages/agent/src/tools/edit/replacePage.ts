/**
 * replace_page — REEMPLAZA una página entera por contenido nuevo BIEN
 * DISEÑADO: el LLM pasa bloques estructurados (título, encabezados, párrafos,
 * viñetas) y el CÓDIGO hace todo el layout (tipografía por tipo, wrap con
 * medición real de la fuente, márgenes, espaciado). El LLM nunca calcula
 * coordenadas ni tamaños — solo estructura el contenido.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';
import type { PageBlock } from '@aldus/core/bake';

const BLOCK = z.object({
  type: z.enum(['title', 'heading', 'subheading', 'paragraph', 'bullet', 'spacer'])
    .describe('tipo tipográfico: title (18pt bold) · heading (14 bold) · subheading (12 bold) · paragraph (11) · bullet (11 con viñeta) · spacer (espacio en blanco)'),
  text: z.string().optional().describe('el contenido del bloque (omitir para spacer)'),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('color hex'),
  align: z.enum(['left', 'center']).optional().describe('center solo para títulos de una línea'),
});

export const replacePageTool: IAgentTool = {
  name: 'replace_page',
  description:
    'REEMPLAZA una página ENTERA por contenido nuevo con diseño ordenado. Pasá los ' +
    'bloques en orden (title/heading/subheading/paragraph/bullet/spacer) y el layout ' +
    '(tamaños, wrap, márgenes, espaciado) se calcula solo. Usala cuando pidan ' +
    '"rehacé/reemplazá/rediseñá la página X" o generar una página desde cero. ' +
    'Borra el texto existente de la página (los campos e imágenes quedan).',
  level: 'editor',
  shape: {
    page: z.number().int().positive().describe('página a reemplazar (1-based)'),
    blocks: z.array(BLOCK).min(1).describe('los bloques del contenido nuevo, en orden de lectura'),
    font: z.enum(['serif', 'sans']).optional().describe('familia (default serif, como un contrato)'),
  },

  run: ({ session }, args) => session.replacePage(
    args.page as number,
    args.blocks as PageBlock[],
    (args.font as 'serif' | 'sans' | undefined) ?? 'serif',
  ),
};
