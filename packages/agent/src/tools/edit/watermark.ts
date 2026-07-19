/**
 * watermark — estampa una marca de agua diagonal en TODAS las páginas.
 * Delegación pura a EditSession.watermark.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const watermarkTool: IAgentTool = {
  name: 'watermark',
  description:
    'Estampa una marca de agua (texto en diagonal, gris translúcido) en todas las ' +
    'páginas. text = la leyenda (ej "BORRADOR", "CONFIDENCIAL"). color/opacity opcionales.',
  level: 'editor',
  shape: {
    text: z.string().min(1).describe('el texto de la marca de agua'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('color hex (default gris)'),
    opacity: z.number().min(0).max(1).optional().describe('opacidad 0..1 (default suave)'),
  },

  run: ({ session }, args) => session.watermark(args.text as string, args.color as string | undefined, args.opacity as number | undefined),
};
