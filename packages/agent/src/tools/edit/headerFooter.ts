/**
 * header_footer — agrega encabezado y/o pie de página (y opcional numeración) a
 * todas las páginas. Delegación pura a EditSession.headerFooter.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const headerFooterTool: IAgentTool = {
  name: 'header_footer',
  description:
    'Agrega encabezado y/o pie de página a todas las páginas. header/footer = texto ' +
    '(al menos uno). page_numbers=true agrega "Página N" al pie.',
  level: 'editor',
  shape: {
    header: z.string().optional().describe('texto del encabezado (arriba)'),
    footer: z.string().optional().describe('texto del pie (abajo)'),
    page_numbers: z.boolean().optional().describe('true = numerar las páginas'),
  },

  run: ({ session }, args) => session.headerFooter({
    header: args.header as string | undefined,
    footer: args.footer as string | undefined,
    pageNumbers: args.page_numbers as boolean | undefined,
  }),
};
