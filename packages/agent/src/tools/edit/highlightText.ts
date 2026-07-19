/**
 * highlight_text — resalta (marca) un nodo de texto existente. color hex
 * opcional (default amarillo). Delegación pura a EditSession.highlightText.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const highlightTextTool: IAgentTool = {
  name: 'highlight_text',
  description: 'Resalta un nodo de texto existente, por id. color hex opcional (ej "#fff176"); default amarillo.',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del nodo de texto a resaltar'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('color del resaltado (hex)'),
  },

  run: ({ session }, args) => session.highlightText(args.id as string, args.color as string | undefined),
};
