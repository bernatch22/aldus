/**
 * fill_field / fill_fields — COMPLETA campos de formulario por nombre (o id).
 * Determinístico. Para varios campos, fill_fields en una sola llamada.
 * Delegación pura a EditSession.fillField / fillFields.
 *
 * NIVEL 'both' (única excepción entre las tools de edición): completar un
 * formulario NO necesita el grafo con ids ni coordenadas — alcanza el NOMBRE del
 * campo, que la vista de lectura ya lista ({@link serializeReading}). Por eso el
 * READER puede rellenar solo, sin delegar en el editor: es la operación que el
 * usuario pide en la pestaña de lectura ("completá esto con mis datos") y
 * mandarla al modelo caro con el grafo entero sería tirar plata.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

/** value: texto (text/select), "true"/"false" (checkbox), o lista (list). */
const toValue = (v: string): string | boolean =>
  v === 'true' ? true : v === 'false' ? false : v;

export const fillFieldTool: IAgentTool = {
  name: 'fill_field',
  description:
    'Completa UN campo de formulario por su nombre (o id de widget). value: texto ' +
    'para text/select, "true"/"false" para checkbox. Para varios, usá fill_fields.',
  level: 'both',
  shape: {
    name: z.string().min(1).describe('fieldName del campo (o su id p1-w3)'),
    value: z.string().describe('valor: texto, o "true"/"false" para checkbox'),
  },

  run: ({ session }, args) => session.fillField(args.name as string, toValue(args.value as string)),
};

export const fillFieldsTool: IAgentTool = {
  name: 'fill_fields',
  description: 'Completa VARIOS campos de formulario en una sola llamada (lista de {name, value}).',
  level: 'both',
  shape: {
    fields: z.array(z.object({
      name: z.string().min(1).describe('fieldName (o id de widget)'),
      value: z.string().describe('valor: texto, o "true"/"false" para checkbox'),
    })).min(1).describe('los campos a completar'),
  },

  run: ({ session }, args) => session.fillFields(
    (args.fields as Array<{ name: string; value: string }>).map(f => ({ name: f.name, value: toValue(f.value) })),
  ),
};
