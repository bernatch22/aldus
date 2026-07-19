/**
 * add_form_field — crea un campo de formulario NUEVO en una posición libre.
 * Para convertir "……" en campos usá placeholders_to_fields; esto es para un
 * campo suelto donde no hay placeholder. Delegación pura a EditSession.addField.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

const KINDS = ['text', 'checkbox', 'radio', 'select', 'list', 'button', 'signature'] as const;

export const addFormFieldTool: IAgentTool = {
  name: 'add_form_field',
  description:
    'Crea un campo de formulario NUEVO (text/checkbox/radio/select/list/signature) ' +
    'en x/y (puntos PDF). Para convertir puntos suspensivos en campos usá ' +
    'placeholders_to_fields; esto es para un campo suelto sin placeholder.',
  level: 'editor',
  shape: {
    field_type: z.enum(KINDS).describe('tipo de campo'),
    page: z.number().int().positive().describe('página (1-based)'),
    x: z.number().describe('x en puntos'),
    y: z.number().describe('y en puntos'),
    width: z.number().positive().optional().describe('ancho en pt (default por tipo)'),
    height: z.number().positive().optional().describe('alto en pt (default por tipo)'),
    name: z.string().optional().describe('nombre del campo (snake_case)'),
  },

  run: ({ session }, args) => session.addField(
    args.field_type as (typeof KINDS)[number],
    args.page as number,
    args.x as number,
    args.y as number,
    args.width as number | undefined,
    args.height as number | undefined,
    args.name as string | undefined,
  ),
};
