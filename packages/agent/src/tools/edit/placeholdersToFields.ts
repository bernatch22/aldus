/**
 * placeholders_to_fields — convertir los huecos de un párrafo ("……", "....",
 * "____") en CAMPOS de formulario reales, colocados sobre el rect exacto de
 * cada placeholder. La división del trabajo es la tesis del motor:
 *
 *   el LLM DETECTA (qué placeholder es qué campo, con nombre semántico) —
 *   el CÓDIGO hace TODO el layout (matchPlaceholders de core: leaders
 *   elásticos, flex multi-línea, des-hifenado, barrido de huérfanos, charXOf)
 *   sin tocar el texto: cero reflow, cero coordenadas del modelo.
 *
 * Es además la salida correcta cuando edit_text rechaza reescribir un
 * placeholder (guardrail de EditSession.editText).
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const placeholdersToFieldsTool: IAgentTool = {
  name: 'placeholders_to_fields',
  description:
    'Convierte los placeholders de un párrafo en campos de formulario. DOS modos ' +
    'automáticos: leaders ("……", "....", "____") → campo EXACTAMENTE sobre cada hueco, ' +
    'sin tocar el texto; rellenos SIN leader ("XXXX", "xxx", "***") → el relleno se ' +
    'ELIMINA (queda un hueco en blanco al ancho útil del dato, el párrafo se reacomoda ' +
    'solo) y el campo va sobre ese hueco. Pasá el id de cualquier línea del párrafo y, ' +
    'EN ORDEN de aparición, un {placeholder, name} por hueco — CADA hueco es un field ' +
    'SEPARADO ("XX de XXXXXX de XXXX" = TRES fields, no uno): placeholder = un substring ' +
    'EXACTO de esa línea que identifique el hueco (incluí texto vecino si hay varios), ' +
    'name = nombre semántico del campo en snake_case. Un párrafo ya convertido devuelve ↩︎.',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id de una línea del párrafo (ej: p1-y659-x85)'),
    fields: z.array(z.object({
      placeholder: z.string().min(2).describe('substring exacto de la línea que contiene/identifica el hueco'),
      name: z.string().min(2).describe('nombre del campo, snake_case (ej: "fecha_firma", "razon_social")'),
      width: z.number().positive().optional().describe('ancho útil en pt (solo si el hueco real es más chico que el placeholder)'),
    })).min(1).describe('un item por hueco, en el ORDEN en que aparecen en el párrafo'),
  },

  run: ({ session }, args) =>
    session.placeholdersToFields(
      args.id as string,
      args.fields as Array<{ placeholder: string; name: string; width?: number }>,
    ),
};
