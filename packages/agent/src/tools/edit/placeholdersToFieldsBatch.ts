/**
 * placeholders_to_fields_batch — TODOS los párrafos con placeholders de una
 * página en UNA sola llamada del modelo. Misma división del trabajo que la
 * versión de a uno (el LLM detecta {placeholder, name}, el código hace el
 * layout), pero el modelo describe la página COMPLETA en un tool call en vez
 * de encadenar N idas y vueltas — que era el cuello de botella real (una página
 * de 8 párrafos = 8 pasadas de LLM en serie).
 *
 * Cada grupo se aplica independiente contra la sesión: un párrafo que falla no
 * tumba a los demás, y el resultado reporta grupo por grupo.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';
import { classify } from '../registry.js';

const GROUP = z.object({
  id: z.string().regex(/^p\d+-\S+$/).describe('id de una línea del párrafo (ej: p1-y659-x85)'),
  fields: z.array(z.object({
    placeholder: z.string().min(2).describe('substring exacto de la línea que contiene/identifica el hueco'),
    name: z.string().min(2).describe('nombre del campo, snake_case'),
    width: z.number().positive().optional().describe('ancho útil en pt (solo si el hueco real es más chico)'),
  })).min(1).describe('un item por hueco, en ORDEN de aparición en el párrafo'),
});

export const placeholdersToFieldsBatchTool: IAgentTool = {
  name: 'placeholders_to_fields_batch',
  description:
    'Convierte los placeholders ("……", "....", "____", y rellenos "XXXX"/"xxx"/"***") ' +
    'de VARIOS párrafos en campos, en UNA sola llamada. Preferila SIEMPRE que haya que ' +
    'convertir más de un párrafo: pasá un grupo {id, fields} por párrafo con placeholders. ' +
    'Cada grupo es como una llamada a placeholders_to_fields (id = una línea del párrafo; ' +
    'fields en orden; cada hueco un field separado — "XX de XXXXXX de XXXX" = 3 fields).',
  level: 'editor',
  shape: {
    groups: z.array(GROUP).min(1).describe('un grupo por párrafo que tenga placeholders'),
  },

  run: async ({ session }, args) => {
    const groups = args.groups as Array<z.infer<typeof GROUP>>;

    // ── FUSIÓN POR PÁRRAFO (antes de tocar nada) ────────────────────────────
    // El modelo manda un grupo por LÍNEA con huecos, pero la conversión es por
    // PÁRRAFO: la primera llamada convierte TODOS los huecos del párrafo (el
    // reflow es uno solo) y las líneas hermanas devolvían `↩︎ ya convertido`.
    // Eso se leía como fallo, el modelo gastaba turnos re-verificando, y sus
    // nombres semánticos para esos huecos se perdían (el barrido los dejaba
    // como campo_N). Fusionados, van todos los fields[] en UNA conversión.
    interface Merged { id: string; ids: string[]; fields: z.infer<typeof GROUP>['fields'] }
    const merged: Merged[] = [];
    const byAnchor = new Map<string, Merged>();
    for (const g of groups) {
      const anchor = session.paragraphAnchor(g.id) ?? g.id;
      const hit = byAnchor.get(anchor);
      if (hit) {
        hit.ids.push(g.id);
        hit.fields.push(...g.fields);
      } else {
        const m: Merged = { id: g.id, ids: [g.id], fields: [...g.fields] };
        byAnchor.set(anchor, m);
        merged.push(m);
      }
    }

    const lines: string[] = [];
    let created = 0;
    let failed = 0;
    let noop = 0;

    for (const m of merged) {
      // Contamos por DIFERENCIA real de campos encolados, no parseando el texto
      // que devuelve la operación.
      const fieldsBefore = session.queuedFieldCount;
      const msg = await session.placeholdersToFields(m.id, m.fields);
      created += session.queuedFieldCount - fieldsBefore;

      const same = m.ids.length > 1 ? ` (${m.ids.join(' + ')} son el MISMO párrafo — fusionados)` : '';
      lines.push(`  ${m.id}${same}: ${msg}`);

      // El desenlace sale de `classify` (el ÚNICO lugar que conoce los prefijos
      // del protocolo), no de tres startsWith repartidos acá. 'skipped' no es ni
      // éxito ni fallo: contarlo como convertido — lo que hacía antes — produce
      // un encabezado que MIENTE, y el modelo lo nota y sale a re-verificar.
      const { code } = classify(msg);
      if (code === 'skipped') noop++;
      else if (code !== 'ok') failed++;
    }

    const ok = merged.length - failed - noop;
    const head = [
      `✓ ${created} campo(s) creados en ${ok}/${merged.length} párrafo(s)`,
      noop ? `${noop} sin cambios (ya tenían campo)` : '',
      failed ? `${failed} con problema` : '',
    ].filter(Boolean).join(' · ');
    return [`${head}:`, ...lines].join('\n');
  },
};
