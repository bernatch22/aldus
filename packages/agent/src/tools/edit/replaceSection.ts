/**
 * replace_section — reemplaza una SECCIÓN entera (que puede CRUZAR páginas) por
 * un párrafo. Es lo que replace_paragraph no puede: start_id y end_id pueden
 * estar en páginas distintas. El span se colapsa — el primer nodo pasa a ser el
 * texto nuevo, el resto se elimina. Delegación pura a EditSession.replaceSection.
 *
 * Sólo la ve el editor NO-fan-out (el que abarca todas las páginas de la
 * sección); un editor de una sola página no tendría ambos ids.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const replaceSectionTool: IAgentTool = {
  name: 'replace_section',
  description:
    'Reemplaza una SECCIÓN entera por un párrafo, aunque CRUCE varias páginas ' +
    '(start_id en una página, end_id en otra). Usala para "reemplazá toda la ' +
    'cláusula/sección X" cuando abarca más de una página — replace_paragraph NO ' +
    'sirve ahí (exige misma página). Colapsa el bloque: el texto nuevo queda donde ' +
    'empezaba la sección, el resto se elimina.',
  level: 'editor',
  shape: {
    start_id: z.string().regex(/^p\d+-\S+$/).describe('id del primer nodo de la sección'),
    end_id: z.string().regex(/^p\d+-\S+$/).describe('id del último nodo de la sección (puede ser de otra página)'),
    text: z.string().min(1).describe('el párrafo nuevo que reemplaza toda la sección'),
  },

  run: ({ session }, args) => session.replaceSection(args.start_id as string, args.end_id as string, args.text as string),
};
