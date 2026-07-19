/**
 * insert_image — inserta una imagen desde un archivo LOCAL (PNG/JPG) en una
 * posición. Delegación pura a EditSession.insertImageFile. El host es quien tiene
 * acceso al filesystem; la ruta debe existir en la máquina que corre el agente.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const insertImageTool: IAgentTool = {
  name: 'insert_image',
  description:
    'Inserta una imagen (PNG/JPG) desde una ruta LOCAL, en x/y (puntos PDF, esquina ' +
    'inferior-izquierda). max_width limita el ancho (mantiene proporción). La ruta ' +
    'debe existir en la máquina del agente — típico para logos/firmas.',
  level: 'editor',
  shape: {
    page: z.number().int().positive().describe('página (1-based)'),
    x: z.number().describe('x en puntos'),
    y: z.number().describe('y en puntos (esquina inferior-izquierda)'),
    path: z.string().min(1).describe('ruta local del archivo de imagen (PNG/JPG)'),
    max_width: z.number().positive().optional().describe('ancho máximo en pt (mantiene proporción)'),
  },

  run: ({ session }, args) => session.insertImageFile(
    args.page as number,
    args.x as number,
    args.y as number,
    args.path as string,
    args.max_width as number | undefined,
  ),
};
