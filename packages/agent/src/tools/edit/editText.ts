/**
 * edit_text — la PRIMERA tool de edición (F3) y la más usada: reemplazar el
 * texto de un nodo existente, anclado por ID del grafo (nunca por coordenadas).
 *
 * Toda la inteligencia vive en EditSession.editText (compartida con el server):
 * diff estilado run-por-run, reflow determinístico si el texto no entra en el
 * renglón, guardrail de placeholders. La tool solo delega — un camino de
 * escritura, cero lógica duplicada.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const editTextTool: IAgentTool = {
  name: 'edit_text',
  description:
    'Reemplaza el TEXTO COMPLETO de un nodo existente, por id (ej: p1-y711-x154). ' +
    'Si el texto nuevo no entra en el renglón, el párrafo se reconstruye solo ' +
    '(reflow) — no calcules nada de layout. Conservá idioma y mayúsculas del original.',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del nodo de texto EXACTO como aparece en el grafo (ej: p1-y711-x154)'),
    text: z.string().min(1).describe('el texto NUEVO completo del nodo (reemplaza todo su contenido)'),
  },

  run: ({ session }, args) => session.editText(args.id as string, args.text as string),
};
