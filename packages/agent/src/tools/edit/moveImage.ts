/**
 * move_image — reposiciona y/o REDIMENSIONA una imagen por id. x/y/width/height
 * en puntos PDF (origen abajo-izquierda). Delegación pura a EditSession.moveImage.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const moveImageTool: IAgentTool = {
  name: 'move_image',
  description:
    'Mueve y/o redimensiona una imagen, por id. x/y/width/height en puntos PDF ' +
    '(origen abajo-izquierda). Mandá solo lo que quieras cambiar.',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id de la imagen'),
    x: z.number().optional().describe('nueva x'),
    y: z.number().optional().describe('nueva y'),
    width: z.number().positive().optional().describe('nuevo ancho'),
    height: z.number().positive().optional().describe('nuevo alto'),
  },

  run: ({ session }, args) => session.moveImage(args.id as string, {
    x: args.x as number | undefined,
    y: args.y as number | undefined,
    width: args.width as number | undefined,
    height: args.height as number | undefined,
  }),
};
