/**
 * delete_text — elimina un nodo de texto entero (sus ops se extirpan del stream
 * en el bake). Anclado por id. Para CAMBIAR el texto usá edit_text; esto es para
 * SACARLO (una línea sobrante, un sello, una nota).
 *
 * `pull_up` sube lo que queda debajo. Dos modos:
 *   'gap'  — cierra el hueco: el contenido sube lo que medía el nodo.
 *   'top'  — sube todo al tope de la página (reclama el margen superior).
 * Sin `pull_up`, el nodo desaparece pero el espacio queda en blanco.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const deleteTextTool: IAgentTool = {
  name: 'delete_text',
  description:
    'Elimina por completo un nodo de texto, por id (ej: p1-y659-x85). El texto ' +
    'desaparece del PDF. Para reemplazarlo por otro texto usá edit_text, no esto. ' +
    'pull_up controla si el contenido de abajo sube: omitilo para dejar el hueco ' +
    'en blanco; "gap" para cerrar el hueco que dejó el nodo; "top" para subir todo ' +
    'al tope de la página (ej: "borrá el título y subí todo arriba" → "top").',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del nodo de texto a eliminar'),
    pull_up: z.enum(['gap', 'top']).optional().describe('"gap" = cerrar el hueco · "top" = subir todo al tope · omitir = dejar en blanco'),
  },

  run: ({ session }, args) =>
    args.pull_up
      ? session.deleteTextPullUp(args.id as string, args.pull_up as 'gap' | 'top')
      : session.deleteText(args.id as string),
};
