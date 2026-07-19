/**
 * add_link — convierte un nodo de texto existente en un hipervínculo. Delegación
 * pura a EditSession.linkText.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const addLinkTool: IAgentTool = {
  name: 'add_link',
  description: 'Convierte un nodo de texto en un link (hipervínculo), por id. url = destino (https://…).',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del nodo de texto'),
    url: z.string().url().describe('URL destino del link'),
  },

  run: ({ session }, args) => session.linkText(args.id as string, args.url as string),
};
