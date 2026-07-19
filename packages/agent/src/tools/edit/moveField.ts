/**
 * move_field — reposiciona un campo de formulario (widget) por id. x/y en puntos
 * PDF (origen abajo-izquierda). Delegación pura a EditSession.moveField.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const moveFieldTool: IAgentTool = {
  name: 'move_field',
  description:
    'Mueve un campo de formulario a otra posición, por id. x/y en puntos PDF ' +
    '(origen abajo-izquierda). Mandá x y/o y — lo que omitas no se toca.',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del campo (widget)'),
    x: z.number().optional().describe('nueva x, en puntos'),
    y: z.number().optional().describe('nueva y, en puntos'),
  },

  run: ({ session }, args) => session.moveField(args.id as string, args.x as number | undefined, args.y as number | undefined),
};
