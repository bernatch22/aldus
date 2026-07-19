/**
 * replace_paragraph — reescribe un PÁRRAFO entero (o un bloque de varios
 * párrafos con end_id) con reflow determinístico: el texto nuevo se re-parte en
 * renglones que respetan el ancho de la columna, y el contenido de abajo se corre
 * lo justo. Es la tool para "reescribí esta cláusula", donde el largo cambia
 * mucho y edit_text (un nodo, un renglón) no alcanza.
 *
 * Toda la inteligencia (medición, wrap, corrimiento, aborto si no entra) vive en
 * EditSession.replaceParagraph — la MISMA del server. La tool solo delega.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const replaceParagraphTool: IAgentTool = {
  name: 'replace_paragraph',
  description:
    'Reescribe un párrafo COMPLETO por otro texto, re-fluyendo los renglones solo ' +
    '(no calcules layout). Para una CLÁUSULA de varios párrafos pasá end_id = el id ' +
    'del último párrafo del bloque (mismo x, misma página): reemplaza TODO el bloque ' +
    'en una llamada. Para cambiar una sola línea corta usá edit_text; para borrar, ' +
    'delete_text. NO la uses para convertir "……"/"____" en campos (eso es ' +
    'placeholders_to_fields — escribir "[____]" con texto NO crea un campo).',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del primer nodo del párrafo/bloque'),
    text: z.string().min(1).describe('el texto NUEVO completo del párrafo/bloque'),
    end_id: z.string().regex(/^p\d+-\S+$/).optional().describe('id del último nodo del bloque (para reemplazar varios párrafos de una)'),
  },

  run: ({ session }, args) =>
    session.replaceParagraph(args.id as string, args.text as string, args.end_id as string | undefined),
};
