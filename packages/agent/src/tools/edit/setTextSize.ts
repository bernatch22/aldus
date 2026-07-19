/**
 * set_text_size — tamaño de fuente (pt) de un nodo de texto entero. Delegación
 * pura a EditSession.resizeText. NO re-fluye el párrafo: cambia solo el tamaño
 * del nodo (para reescalar y re-acomodar, usá replace_paragraph).
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const setTextSizeTool: IAgentTool = {
  name: 'set_text_size',
  description: 'Cambia el TAMAÑO de fuente (en puntos) de un nodo de texto entero, por id. size = número de puntos (ej: 14).',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del nodo de texto'),
    size: z.number().positive().max(200).describe('tamaño en puntos PDF (ej: 12, 14, 18)'),
  },

  run: ({ session }, args) => session.resizeText(args.id as string, args.size as number),
};
