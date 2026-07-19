/**
 * move_text — reposiciona un nodo de texto (puntos PDF, origen abajo-izquierda,
 * y = baseline). Pasá x y/o y; lo que no mandes queda igual. Delegación pura.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const moveTextTool: IAgentTool = {
  name: 'move_text',
  description:
    'Mueve un nodo de texto a otra posición, por id. x/y en puntos PDF (origen ' +
    'abajo-izquierda, y = baseline). Mandá x y/o y — lo que omitas no se toca.',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del nodo de texto'),
    x: z.number().optional().describe('nueva x (izquierda del texto), en puntos'),
    y: z.number().optional().describe('nueva y (baseline), en puntos'),
  },

  run: ({ session }, args) => session.moveText(args.id as string, args.x as number | undefined, args.y as number | undefined),
};
