/**
 * verify.ts — verificación GEOMÉTRICA determinística post-edición: hornea la
 * sesión en memoria, re-extrae el grafo REAL y reporta cada widget que pisa
 * texto de su renglón (o a otro widget). El reporte se le devuelve al editor
 * EN EL MISMO turno para que corrija con move_text/move_field — el LLM decide
 * todo, esto solo mide. Sin heurísticas de contenido: solo geometría.
 *
 * v2 (audit-agent §1, duplicación #3): consume el `charXOf` CANÓNICO de core —
 * MUERTO el `charXMap` naïve de v1 (repartía el ancho UNIFORME por carácter, un
 * run mixto palabras+leaders corría el borde ~50pt y disparaba falsos positivos).
 */
import { charXOf } from '@aldus/core';
import { graphFromBytes } from './graph.js';
import type { DocGraph } from './graph.js';
import type { EditSession } from './session/EditSession.js';

function pageIssues(p: DocGraph['pages'][number]): string[] {
  const out: string[] = [];
  for (const w of p.widgets) {
    // Texto del MISMO renglón: la baseline vive cerca del BORDE INFERIOR del
    // widget (los campos se crean a y = baseline−3). Rango corto a propósito:
    // con un alto de ~16pt, medio campo llega a la línea de arriba y la
    // marcaría como falso positivo.
    for (const s of p.segments) {
      if (s.baseline < w.y - 2 || s.baseline > w.y + Math.min(w.height, 9)) continue;
      const map = charXOf(s);
      let hit = '';
      for (let i = 0; i < s.text.length; i++) {
        if (s.text[i] === ' ') continue;
        const mid = (map[i]! + map[i + 1]!) / 2;
        if (mid > w.x + 1 && mid < w.x + w.width - 1) hit += s.text[i];
      }
      // Un campo SOBRE un "____"/"...." (renglón de plantilla) es INTENCIONAL:
      // así se hace fillable un PDF. No es un solape a corregir → se ignora.
      const onlyPlaceholder = /^[_.·\-–—\s]*$/.test(hit);
      if (hit.trim().length > 0 && !onlyPlaceholder) {
        out.push(
          `- el campo "${w.fieldName}" (p${p.page}, x ${Math.round(w.x)}–${Math.round(w.x + w.width)}) ` +
          `PISA el texto ${JSON.stringify(hit.trim().slice(0, 30))} del nodo ${s.id} (que arranca en x=${Math.round(s.x)}). ` +
          `Arreglo: move_text ${s.id} a x=${Math.round(w.x + w.width + 6)}, o mové/achicá el campo.`,
        );
      }
    }
    // Widget contra widget EN LA MISMA LÍNEA (solape vertical >50% del alto — dos
    // campos de líneas contiguas que apenas se tocan no son un problema).
    for (const o of p.widgets) {
      if (o === w || w.x > o.x) continue;
      const vov = Math.min(w.y + w.height, o.y + o.height) - Math.max(w.y, o.y);
      if (vov < w.height * 0.5) continue;
      const ov = Math.min(w.x + w.width, o.x + o.width) - Math.max(w.x, o.x);
      if (ov > 2) out.push(`- los campos "${w.fieldName}" y "${o.fieldName}" (p${p.page}) se solapan ${Math.round(ov)}pt en el mismo renglón — mové uno con move_field.`);
    }
  }
  return out;
}

/** Reporte de solapamientos de la sesión (horneando en memoria). Vacío = OK. */
export async function overlapReport(session: EditSession): Promise<string[]> {
  const { pdf } = await session.bake();
  const doc = await graphFromBytes(pdf.slice());
  return doc.pages.flatMap(pageIssues);
}

/** Mensaje imperativo para devolverle al editor los solapamientos a corregir. */
export function verifyMessage(issues: string[]): string {
  return [
    `Verificación de layout del editor Aldus: horneé tus cambios y medí el grafo real.`,
    `Detecté ${issues.length} solape(s) que probablemente no querías. Cada línea trae`,
    `el arreglo sugerido (move_text/move_field, o delete_field + add_form_field más`,
    `angosto). Aplicá los que correspondan; si alguno es intencional, dejalo y seguí.`,
    ...issues,
  ].join('\n');
}
