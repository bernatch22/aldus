/**
 * set_text_style — negrita / itálica de un nodo de texto entero. El bake
 * re-encoda con la variante de fuente correspondiente (si el PDF no la trae
 * embebida, cae a la estándar equivalente y lo reporta). Delegación pura.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const setTextStyleTool: IAgentTool = {
  name: 'set_text_style',
  description:
    'Pone o saca NEGRITA e ITÁLICA de un nodo de texto entero, por id. Pasá bold ' +
    'y/o italic (true = poner, false = sacar). Al menos uno.',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del nodo de texto'),
    bold: z.boolean().optional().describe('true = negrita · false = sin negrita'),
    italic: z.boolean().optional().describe('true = itálica · false = sin itálica'),
  },

  run: ({ session }, args) =>
    session.styleText(args.id as string, { bold: args.bold as boolean | undefined, italic: args.italic as boolean | undefined }),
};
