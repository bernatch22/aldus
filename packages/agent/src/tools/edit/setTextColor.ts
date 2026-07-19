/**
 * set_text_color — color de un nodo de texto entero (hex). Delegación pura a
 * EditSession.colorText.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const setTextColorTool: IAgentTool = {
  name: 'set_text_color',
  description: 'Cambia el COLOR de un nodo de texto entero, por id. color = hex (ej: "#c0392b", "#000000").',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del nodo de texto'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('color en hex de 6 dígitos, ej "#1a1a1a"'),
  },

  run: ({ session }, args) => session.colorText(args.id as string, args.color as string),
};
