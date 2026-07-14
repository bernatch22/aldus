/**
 * instantOps.ts — el registry {@link IInstantOp} (audit-hosts §3.5): las
 * operaciones instantáneas de POST /:id/ops como DATA multi-bound, en vez del
 * switch de 8 casos de v1. La ruta hace `ops.find(o => o.name === action)` →
 * `unknownOp` si nadie reclama; una capability nueva = un objeto + un bind en
 * la composition root — la ruta no se toca (OCP).
 *
 * Las IMPLS son los creators de `core/create` (cero lógica acá): cada op
 * valida sus params con zod (LOOSE — v1 no validaba nada y los creators son
 * tolerantes; el schema solo exige lo que sin lo cual core explota) y devuelve
 * los bytes nuevos. La ruta persiste.
 *
 * Los `name` son el WIRE de la UI (aldusApi.docOp) — NO renombrar: 'watermark'
 * y 'headerFooter' difieren a propósito de los kinds de core ('addWatermark'…).
 */
import { z } from 'zod';
import { createToken } from '@aldus/core';
import {
  addHeaderFooter,
  addHighlight,
  addLink,
  addRadioOption,
  addText,
  addWatermark,
  removeLink,
  setFieldOptions,
} from '@aldus/core/bake';
import { linkNotFound } from './errors.js';

export interface IInstantOp {
  /** El `action` del wire (POST /:id/ops { action, ...params }). */
  name: string;
  /** Validación de params. LOOSE: campos extra pasan (paridad con v1). */
  schema: z.ZodType<Record<string, unknown>>;
  /** bytes → bytes. Tira ProtocolError para fallos con semántica HTTP propia. */
  run(bytes: Uint8Array, params: Record<string, unknown>): Promise<Uint8Array>;
}
export const IInstantOp = createToken<IInstantOp>('IInstantOp');

const rect = { page: z.number(), x: z.number(), y: z.number(), width: z.number(), height: z.number() };

/** Las 8 ops de v1, mismas acciones y semántica (removeLink → 404 si no está). */
export function defaultInstantOps(): IInstantOp[] {
  return [
    {
      name: 'addText',
      schema: z.looseObject({ page: z.number(), x: z.number(), y: z.number(), text: z.string() }),
      run: async (b, p) => (await addText(b, p as never)).pdf,
    },
    {
      name: 'watermark',
      schema: z.looseObject({ text: z.string() }),
      run: async (b, p) => (await addWatermark(b, p as never)).pdf,
    },
    {
      name: 'headerFooter',
      schema: z.looseObject({}),
      run: async (b, p) => (await addHeaderFooter(b, p as never)).pdf,
    },
    {
      name: 'highlight',
      schema: z.looseObject(rect),
      run: async (b, p) => (await addHighlight(b, p as never)).pdf,
    },
    {
      name: 'addLink',
      schema: z.looseObject({ ...rect, url: z.string() }),
      run: async (b, p) => (await addLink(b, p as never)).pdf,
    },
    {
      name: 'setFieldOptions',
      schema: z.looseObject({ fieldName: z.string(), options: z.array(z.string()) }),
      run: async (b, p) => (await setFieldOptions(b, p as never)).pdf,
    },
    {
      name: 'addRadioOption',
      schema: z.looseObject({ fieldName: z.string(), page: z.number(), x: z.number(), y: z.number() }),
      run: async (b, p) => (await addRadioOption(b, p as never)).pdf,
    },
    {
      name: 'removeLink',
      schema: z.looseObject(rect),
      run: async (b, p) => {
        const r = await removeLink(b, p as never);
        if (!r.removed) throw linkNotFound();
        return r.pdf;
      },
    },
  ];
}
