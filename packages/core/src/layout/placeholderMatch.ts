/**
 * layout/placeholderMatch.ts — el matching + colocación de placeholders_to_fields
 * como FUNCIÓN PURA (Layer 2). El "LLM DETECTA, el CÓDIGO computa": acá vive el
 * "código computa". Trasplante VERBATIM en semántica de v1 session.placeholdersToFields
 * (menos paragraphOf, que es geometría de párrafo, y menos el bake — la colocación
 * es DIRECTA, cero reflow).
 *
 * Defensas pagadas con sangre (audit-agent §4), INTACTAS:
 *  - #2 leader elástico (el LLM nunca copia el conteo de puntos; '.'+'…' mezclados)
 *  - #3 regex flex multi-línea + des-hifenado Word ("[ad-" / "dress]")
 *  - #4 expansión de bordes al run máximo de leaders
 *  - #5 barrido de leaders huérfanos (anti segunda-llamada)
 *  - #6 hueco NOMBRADO en la línea del run más largo; el resto `drop`
 *  - #7 colocación DIRECTA por charX + idempotencia por overlap
 *  - #8 charXOf con pesos por glifo (importado de ./charX)
 *  - #1 guardrail XXXX ({@link looksLikeLeaderRewrite}, lo consume edit_text en F5)
 */

import { charXOf } from './charX.js';
import type { ParaLine, ReflowHole } from './paragraph.js';

/** GUARDRAIL #1: ¿reescribir `oldText` como `newText` está borrando un
 *  placeholder de leaders (".....", "____", "……")? edit_text (F5) lo RECHAZA y
 *  redirige a placeholders_to_fields — reescribir leaders a mano rompe el layout. */
export const looksLikeLeaderRewrite = (oldText: string, newText: string): boolean =>
  /[.…_]{4,}/.test(oldText) && !/[.…_]{4,}/.test(newText);

/** Una pista de ancho ÚTIL de campo por nombre (audit-agent §3.2: EN+ES). */
export interface FieldWidthHint {
  pattern: RegExp;
  width: (fontSize: number) => number;
}

/** Tabla por defecto EN+ES. Los MULTIPLICADORES son sagrados (regla dura #2):
 *  nombres/direcciones anchos (~110pt @10), números/fechas medios (~55pt). Solo
 *  se sumaron los términos en inglés (v1 era español-only → un contrato en
 *  inglés caía siempre al default de 80pt). El ORDEN importa: primera que matchea
 *  gana; sin match, el default. */
export const defaultFieldWidthHints: readonly FieldWidthHint[] = [
  { pattern: /nombre|apellido|raz[oó]n|social|domicilio|direcci|empresa|calle|ciudad|cargo|name|surname|address|street|city|company|title|position/i, width: fs => fs * 11 },
  { pattern: /ruc|dni|n[uú]m|partida|c[oó]digo|fecha|tel[eé]fono|cuit|nit|zip|cp\b|date|phone|code|number/i, width: fs => fs * 5.5 },
];

/** Ancho ÚTIL objetivo de un campo (pt): el LLM puede pasarlo explícito (`width`);
 *  si no, se estima por el nombre con la tabla de pistas. */
export function targetWidthFor(
  name: string,
  width: number | undefined,
  fontSize: number,
  hints: readonly FieldWidthHint[] = defaultFieldWidthHints,
): number {
  if (typeof width === 'number' && width > 0) return width;
  for (const h of hints) if (h.pattern.test(name)) return h.width(fontSize);
  return fontSize * 8; // ~80pt @10
}

/** Un placeholder detectado por el LLM: el substring + el nombre del campo. */
export interface PlaceholderField { placeholder: string; name: string; width?: number }

/** Un rect ocupado (widget existente o campo ya encolado) para la idempotencia. */
export interface OccupiedRect { x: number; y: number; width: number }

/** Un campo a CREAR sobre un placeholder (rect en puntos PDF). */
export interface FieldPlacement {
  fieldType: 'text';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
}

export interface PlaceholderMatchResult {
  /** Los campos NUEVOS a crear (en orden de lectura). */
  fields: FieldPlacement[];
  /** Notas legibles por colocación/salto (para el string que arma F5). */
  notes: string[];
  /** true = nada nuevo (todos los placeholders ya tenían campo, o vacío):
   *  la llamada es idempotente (↩︎ no repitas). */
  nothingNew: boolean;
  /** Error de matching (placeholder no encontrado / campo sin placeholder). null = ok. */
  error?: string;
}

export interface MatchContext {
  page: number;
  fontSize: number;
  /** Widgets existentes en la página (idempotencia). */
  existingWidgets: readonly OccupiedRect[];
  /** Campos ya encolados por llamadas anteriores (idempotencia). */
  queuedFields: readonly OccupiedRect[];
  hints?: readonly FieldWidthHint[];
}

/**
 * DETERMINÍSTICO — dado el párrafo (líneas VISUALES) y los placeholders que el
 * LLM detectó, computa los campos a crear SOBRE los huecos reales (charXOf), sin
 * tocar el texto (colocación directa, cero reflow). Pura: cero I/O, cero bake.
 */
export function matchPlaceholders(
  lines: ParaLine[],
  fields: PlaceholderField[],
  ctx: MatchContext,
): PlaceholderMatchResult {
  if (!fields.length) return { fields: [], notes: [], nothingNew: true, error: 'placeholders_to_fields necesita al menos un {placeholder,name}.' };

  // Localizar cada placeholder (en orden de lectura, cruzando líneas). Primero
  // match LITERAL; si falla y el placeholder es un LEADER (puntos/ellipsis/guiones
  // bajos: "....", "………", mezclas), matchea el PRÓXIMO run de leaders de la línea
  // — los PDFs mezclan '.' y '…' (U+2026) y el LLM nunca copia el conteo exacto.
  const LEADER_RUN = /[.…_]{2,}/g;
  const holes: ReflowHole[] = [];
  // El matching es a nivel PÁRRAFO (las líneas unidas con '\n'): un placeholder
  // mixto ("..... [company legal name]") puede cruzar renglones — incluso con un
  // guion de corte de Word en el medio ("[ad-" / "dress, city and country]").
  const joined = lines.map(l => l.text).join('\n');
  const starts: number[] = [];
  { let acc = 0; for (const l of lines) { starts.push(acc); acc += l.text.length + 1; } }
  let gOff = 0;
  for (const f of fields) {
    if (!f.placeholder) return { fields: [], notes: [], nothingNew: true, error: 'un field vino sin placeholder.' };
    const isLeader = /^[.…_\s]+$/.test(f.placeholder);
    // Regex flexible para placeholders mixtos: cada run de leaders es elástico (el
    // LLM jamás copia el conteo exacto de puntos), el texto es literal con espacios
    // flexibles y guion de corte opcional dentro de cada palabra.
    const flex = !isLeader && /[.…_]{2,}/.test(f.placeholder)
      ? new RegExp(f.placeholder.trim().split(/[.…_]{2,}/)
          .map(part => part.trim().split(/\s+/)
            .map(word => word.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:-\\s+)?'))
            .join('\\s+'))
          .join('\\s*[.…_]{2,}\\s*'))
      : null;
    let at = joined.indexOf(f.placeholder, gOff), len = f.placeholder.length;
    if (at < 0 && isLeader) {
      LEADER_RUN.lastIndex = gOff;
      const m = LEADER_RUN.exec(joined);
      if (m) { at = m.index; len = m[0].length; }
    }
    if (at < 0 && flex) {
      const m = flex.exec(joined.slice(gOff));
      if (m) { at = gOff + m.index; len = m[0].length; }
    }
    if (at < 0) return { fields: [], notes: [], nothingNew: true, error: `no encontré ${JSON.stringify(f.placeholder)} en el párrafo (usá el texto EXACTO, en orden de lectura).` };
    // EXPANDIR los bordes al run máximo de leaders: el documento puede tener 67
    // puntos seguidos y el LLM pasa 5 — los sobrantes quedarían como "palabra"
    // gigante. Vale para CUALQUIER match cuyo borde caiga en un leader.
    {
      let a2 = at, b2 = at + len;
      if (/[.…_]/.test(joined[a2] ?? '')) while (a2 > 0 && /[.…_]/.test(joined[a2 - 1]!)) a2--;
      if (/[.…_]/.test(joined[b2 - 1] ?? '')) while (b2 < joined.length && /[.…_]/.test(joined[b2]!)) b2++;
      at = a2; len = b2 - a2;
    }
    // Rango global → rangos POR LÍNEA. El hueco NOMBRADO va en la línea con el run
    // de leaders más largo del match (ahí está el espacio para escribir); el resto
    // del match (el label "[…]", los puntos de otra línea) se DESCARTA.
    const ranges: Array<{ li: number; from: number; to: number; lead: number }> = [];
    for (let k = 0; k < lines.length; k++) {
      const a = Math.max(at, starts[k]!), b = Math.min(at + len, starts[k]! + lines[k]!.text.length);
      if (b <= a) continue;
      const lead = Math.max(0, ...[...lines[k]!.text.slice(a - starts[k]!, b - starts[k]!).matchAll(/[.…_]{2,}/g)].map(m => m[0].length));
      ranges.push({ li: k, from: a - starts[k]!, to: b - starts[k]!, lead });
    }
    const main = ranges.reduce((best, r2) => (r2.lead > best.lead ? r2 : best), ranges[0]!);
    const name = (f.name || '').trim() || `campo_${holes.length + 1}`;
    for (const r2 of ranges) {
      if (r2 !== main) { holes.push({ li: r2.li, from: r2.from, to: r2.to, name: '', target: 0, drop: true }); continue; }
      // Ancho del campo: si el HUECO EXISTENTE ya es generoso (leaders largos:
      // "DATE: .........." mide 300pt), usalo TAL CUAL — cero ensanche = cero
      // reflow = cero corrimiento. Solo se ensancha si el placeholder es angosto.
      const cx = charXOf(lines[r2.li]!);
      const existingW = (cx[r2.to] ?? cx[cx.length - 1]!) - (cx[r2.from] ?? 0);
      const desired = targetWidthFor(f.name ?? '', f.width, ctx.fontSize, ctx.hints);
      holes.push({ li: r2.li, from: r2.from, to: r2.to, name, target: existingW >= desired * 0.9 ? existingW : desired });
    }
    gOff = at + len;
  }

  // BARRIDO de leaders: si el pedido incluía leaders, NINGÚN run de leaders del
  // párrafo puede quedar huérfano — el LLM suele pasar solo algunos y la segunda
  // llamada choca con el anti-recall (el párrafo ya quedó restyled). El reflow es
  // UNO solo por párrafo: se convierten todos acá, con nombre automático los que
  // el LLM no nombró.
  if (fields.some(f => /[.…_]{2,}/.test(f.placeholder))) {
    for (let k = 0; k < lines.length; k++) {
      for (const m of lines[k]!.text.matchAll(/[.…_]{4,}/g)) {
        const a = m.index!, b = a + m[0].length;
        if (holes.some(h => h.li === k && a < h.to && b > h.from)) continue;
        const cx = charXOf(lines[k]!);
        const existingW = (cx[b] ?? cx[cx.length - 1]!) - (cx[a] ?? 0);
        const desired = targetWidthFor('', undefined, ctx.fontSize, ctx.hints);
        holes.push({ li: k, from: a, to: b, name: `campo_${holes.length + 1}`, target: existingW >= desired * 0.9 ? existingW : desired });
      }
    }
    holes.sort((a, b) => a.li - b.li || a.from - b.from);
  }

  // ── COLOCACIÓN DIRECTA, SIN REFLOW ────────────────────────────────────────
  // El placeholder YA ocupa su lugar: el campo se crea EXACTAMENTE sobre ese rect
  // (charXOf = x real de cada glifo) y el texto NO se toca — los puntitos quedan
  // debajo del campo, como en un formulario de papel. Cero reescritura = cero
  // corrupción, e IDEMPOTENTE: si el rect ya tiene un widget (del documento o de
  // esta sesión), se saltea.
  const out: FieldPlacement[] = [];
  const queued: OccupiedRect[] = [...ctx.queuedFields];
  const notes: string[] = [];
  const r2v = (v: number) => Math.round(v * 100) / 100;
  const overlapsExisting = (x: number, y: number, w: number): boolean => {
    const near = (wx: number, wy: number, ww: number) => x < wx + ww && x + w > wx && Math.abs(wy - y) < 8;
    if (ctx.existingWidgets.some(wd => near(wd.x, wd.y, wd.width))) return true;
    return queued.some(c => near(c.x, c.y, c.width));
  };
  for (const h of holes) {
    if (h.drop || !h.name) continue;
    const line = lines[h.li]!;
    const cx = charXOf(line);
    const x0 = cx[h.from] ?? line.seg.x;
    const x1 = cx[h.to] ?? cx[cx.length - 1] ?? x0;
    const w = Math.max(14, x1 - x0);
    const y = line.baseline - 2;
    if (overlapsExisting(x0, y, w)) { notes.push(`(↩︎ ${h.name} ya tiene campo ahí — salteado)`); continue; }
    const field: FieldPlacement = {
      fieldType: 'text', page: ctx.page,
      x: r2v(x0), y: r2v(y), width: r2v(w), height: r2v(line.seg.fontSize + 3),
      name: h.name,
    };
    out.push(field);
    queued.push({ x: field.x, y: field.y, width: field.width });
    notes.push(`${h.name} @(${Math.round(x0)},${Math.round(y)}) ${Math.round(w)}pt`);
  }
  return { fields: out, notes, nothingNew: out.length === 0 };
}
