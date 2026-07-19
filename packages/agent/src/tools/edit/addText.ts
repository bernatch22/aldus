/**
 * add_text — inserta un nodo de texto NUEVO en una posición. y = esquina
 * superior-izquierda (el motor baja el bloque si pisaría texto existente).
 * Delegación pura a EditSession.addTextNode.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const addTextTool: IAgentTool = {
  name: 'add_text',
  description:
    'Inserta texto NUEVO en la página. x/y en puntos PDF (y = borde superior del ' +
    'texto). Si cae sobre texto existente, el motor lo baja al primer hueco libre. ' +
    'Opcional: size (pt), bold, italic, color (hex).',
  level: 'editor',
  shape: {
    page: z.number().int().positive().describe('página (1-based)'),
    x: z.number().describe('x en puntos'),
    y: z.number().describe('y en puntos (borde superior del texto)'),
    text: z.string().min(1).describe('el texto a insertar'),
    size: z.number().positive().max(200).optional().describe('tamaño en pt (default 11)'),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('color hex, ej "#1a1a1a"'),
  },

  run: ({ session }, args) => session.addTextNode({
    page: args.page as number,
    x: args.x as number,
    y: args.y as number,
    text: args.text as string,
    size: args.size as number | undefined,
    bold: args.bold as boolean | undefined,
    italic: args.italic as boolean | undefined,
    color: args.color as string | undefined,
  }),
};
