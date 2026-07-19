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
import type { PageGraph } from '../model/nodes.js';
import type { ParaLine, Paragraph, ReflowHole, ReflowTok } from './paragraph.js';

/** GUARDRAIL #1: ¿reescribir `oldText` como `newText` está borrando un
 *  PLACEHOLDER? edit_text (F5) lo RECHAZA y redirige a placeholders_to_fields —
 *  reescribirlo a mano rompe el layout y NO produce un campo rellenable.
 *
 *  Cubre las DOS familias, porque el modelo intenta emular la tool con ambas:
 *   - LEADERS (".....", "____", "……") → los borra o los deja en otra forma.
 *   - RELLENOS ("XXXX", "xxxxxx", "***") → los reemplaza por espacios, por
 *     "DD/MM/AAAA", o por etiquetas tipo "[Día de Inicio]" (visto en un run real
 *     del editor Gemini: escribe texto que PARECE un hueco pero no se completa).
 *  Un run de relleno que sobrevive igual en el texto nuevo NO es reescritura. */
const FILLER_RUN = /(?<![\p{L}\p{N}])(?:[xX]{3,}|\*{3,})(?![\p{L}\p{N}])/u;
export const looksLikeLeaderRewrite = (oldText: string, newText: string): boolean =>
  (/[.…_]{4,}/.test(oldText) && !/[.…_]{4,}/.test(newText)) ||
  (FILLER_RUN.test(oldText) && !FILLER_RUN.test(newText));

/** GUARDRAIL #1b — para replace_paragraph / replace_section, que operan sobre
 *  BLOQUES (paragraphOf arrastra líneas vecinas: un guard estricto tipo
 *  looksLikeLeaderRewrite bloquearía reescrituras LEGÍTIMAS de cláusulas cuyo
 *  bloque roza un leader ajeno). Acá el criterio es la INTENCIÓN observable:
 *  el bloque viejo tiene placeholders Y el texto nuevo trae PSEUDO-placeholders
 *  — "[Día inicio]", runs de 3+ espacios, siglas DD/MM/AAAA — o sea, el modelo
 *  está "convirtiendo" a mano (visto en un run real de Sonnet cuando edit_text
 *  le rechazó la emulación). Una reescritura real de cláusula NO dispara. */
export const looksLikePlaceholderConversion = (oldText: string, newText: string): boolean =>
  (/[.…_]{4,}/.test(oldText) || FILLER_RUN.test(oldText)) &&
  (/\[[^\]\n]{1,40}\]/.test(newText) || / {3,}/.test(newText) || /\b(?:DD|MM|AAAA|YYYY)\b/.test(newText));

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
  { pattern: /ruc|dni|n[uú]m|partida|c[oó]digo|fecha|tel[eé]fono|cuit|nit|zip|cp\b|date|phone|code|number|d[ií]a|mes|anio|a[nñ]o|day|month|year/i, width: fs => fs * 5.5 },
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
  /** Modo REESCRITURA: hay rellenos sin leader (XXXX, xxx, ***) — el caller
   *  debe correr paragraphToks(para, holes) + reflowApply y colocar con
   *  {@link placeFieldsInGaps}; `fields` viene vacío (la geometría final recién
   *  existe después del reflow horneado). */
  needsReflow?: boolean;
  /** Los huecos (keep + rewrite + drop) para el reflow, en orden de lectura. */
  holes?: ReflowHole[];
}

export interface MatchContext {
  page: number;
  fontSize: number;
  /** Widgets existentes en la página (idempotencia). */
  existingWidgets: readonly OccupiedRect[];
  /** Campos ya encolados por llamadas anteriores (idempotencia). */
  queuedFields: readonly OccupiedRect[];
  hints?: readonly FieldWidthHint[];
  /** Id del nodo consultado — solo para el mensaje de error "no encontré …
   *  en el párrafo de ${id}" (contrato v1 con el LLM: le dice en QUÉ nodo
   *  buscó cuando pasa el id equivocado). [B1 del informe de verificación] */
  nodeId?: string;
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
  const matchNotes: string[] = [];
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
    // Regex flexible para placeholders mixtos: cada run de placeholder (leaders
    // O rellenos xX/*) es elástico (el LLM jamás copia el conteo exacto), el
    // texto es literal con espacios flexibles — cubre el salto de renglón
    // ("XXX de\nXXXXX del XXXX") — y guion de corte opcional en cada palabra.
    // El split respeta bordes de palabra: un "xx" DENTRO de "Exxon" no parte.
    const RUN_SPLIT = /[.…_]{2,}|(?<![\p{L}\p{N}])(?:[xX]{2,}|\*{2,})(?![\p{L}\p{N}])/u;
    const flex = !isLeader && RUN_SPLIT.test(f.placeholder)
      ? new RegExp(f.placeholder.trim().split(new RegExp(RUN_SPLIT.source, 'u'))
          .map(part => part.trim().split(/\s+/)
            .map(word => word.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:-\\s+)?'))
            .join('\\s+'))
          .join('\\s*(?:[.…_]{2,}|[xX]{2,}|\\*{2,})\\s*'), 'u')
      : null;
    // Localizar: primero desde gOff (orden de lectura); si falla, DESDE 0 — el
    // LLM pasa frases-CONTEXTO que se solapan ("XXXXXX de XXXX" ya consumió el
    // "de XXXX" que "de XXXX hasta" necesita). El solape no duplica campos: los
    // huecos ya cubiertos se saltean más abajo.
    const locate = (from: number): { at: number; len: number } | null => {
      const i = joined.indexOf(f.placeholder, from);
      if (i >= 0) return { at: i, len: f.placeholder.length };
      if (isLeader) {
        LEADER_RUN.lastIndex = from;
        const m = LEADER_RUN.exec(joined);
        if (m) return { at: m.index, len: m[0].length };
      }
      if (flex) {
        const m = flex.exec(joined.slice(from));
        if (m) return { at: from + m.index, len: m[0].length };
      }
      return null;
    };
    const loc = locate(gOff) ?? locate(0);
    // Un placeholder NO encontrado no mata el grupo entero: se anota y se sigue
    // — los rellenos/leaders que el LLM citó mal los cubre igual el BARRIDO.
    if (!loc) { matchNotes.push(`(⚠ no encontré ${JSON.stringify(f.placeholder)} — si era un relleno, lo cubre el barrido)`); continue; }
    let { at, len } = loc;
    // EXPANDIR los bordes al run máximo de leaders: el documento puede tener 67
    // puntos seguidos y el LLM pasa 5 — los sobrantes quedarían como "palabra"
    // gigante. Vale para CUALQUIER match cuyo borde caiga en un leader.
    {
      let a2 = at, b2 = at + len;
      if (/[.…_]/.test(joined[a2] ?? '')) while (a2 > 0 && /[.…_]/.test(joined[a2 - 1]!)) a2--;
      if (/[.…_]/.test(joined[b2 - 1] ?? '')) while (b2 < joined.length && /[.…_]/.test(joined[b2]!)) b2++;
      at = a2; len = b2 - a2;
    }
    // RECORTE + SPLIT defensivos: el placeholder del LLM es una FRASE-contexto
    // ("el señor ***", "R.U.C. N° xxxxxxx" — la tool le PIDE texto vecino para
    // desambiguar): el hueco debe cubrir SOLO el/los run/s de relleno o leaders
    // — las palabras de contexto ("el señor", "R.U.C. N°") SOBREVIVEN; un hueco
    // sobre la frase entera se las tragaría (pérdida de contenido) y además
    // infla el ancho hasta hacer abortar el reflow. Varios runs ("XX de XXXXXX
    // de XXXX" como UN field) = un hueco POR RUN (name, name_2, …).
    const isWord = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}]/u.test(ch);
    const baseName = (f.name || '').trim() || `campo_${holes.length + 1}`;
    const matches: Array<{ at: number; len: number; name: string }> = [];
    {
      const slice = joined.slice(at, at + len);
      // El chequeo de borde de palabra aplica SOLO a rellenos x/X/* (un "xx"
      // dentro de "Exxon" no es placeholder). Los LEADERS van siempre: puntos
      // PEGADOS a una palabra ("....Direccion", Word justificado) SON un
      // placeholder legítimo — el caso F3e.
      const runs = [...slice.matchAll(/[.…_]{2,}|[xX*]{2,}/g)]
        .filter(m2 => /[.…_]/.test(m2[0][0]!) ||
          (!isWord(joined[at + m2.index! - 1]) && !isWord(joined[at + m2.index! + m2[0].length])));
      // GUARDRAIL + ANCLA: un match SIN leaders NI rellenos adentro no es un
      // placeholder — es una ETIQUETA descriptiva ("[denominación social de la
      // empresa]"). Convertirla la BORRA del contrato (visto con MiniMax:
      // etiquetas reescritas como huecos + mojibake re-emitido). Pero los LLMs
      // la pasan IGUAL, así que la usamos de ANCLA: el hueco real son los
      // leaders PEGADOS a la etiqueta ("…………. [etiqueta]") — se convierte ESE
      // run y la etiqueta queda intacta. Sin leaders adyacentes: nota y sigue.
      if (runs.length === 0 && !isLeader) {
        const LEAD_CH = /[.…_]/;
        const SKIP_CH = /[\s[\]()"',:]/;
        const skipTo = (i: number, dir: -1 | 1): number => {
          let k = i;
          while (k >= 0 && k < joined.length && SKIP_CH.test(joined[k]!)) k += dir;
          return k;
        };
        let a2 = -1, b2 = -1;
        const li = skipTo(at - 1, -1);
        if (li >= 0 && LEAD_CH.test(joined[li]!)) {
          b2 = li + 1; a2 = li;
          while (a2 > 0 && LEAD_CH.test(joined[a2 - 1]!)) a2--;
        } else {
          const ri = skipTo(at + len, 1);
          if (ri < joined.length && LEAD_CH.test(joined[ri]!)) {
            a2 = ri; b2 = ri + 1;
            while (b2 < joined.length && LEAD_CH.test(joined[b2]!)) b2++;
          }
        }
        if (a2 >= 0 && b2 - a2 >= 2) {
          matches.push({ at: a2, len: b2 - a2, name: baseName });
        } else {
          matchNotes.push(`(↩︎ ${JSON.stringify(f.placeholder.slice(0, 40))} no es un placeholder (sin puntos/guiones/XXXX adentro ni leaders al lado) — es texto descriptivo: no se convierte ni se borra)`);
          continue;
        }
      } else if (runs.length >= 1 && !/^[.…_\s]+$/.test(slice)) {
        runs.forEach((m2, ri) => matches.push({ at: at + m2.index!, len: m2[0].length, name: ri ? `${baseName}_${ri + 1}` : baseName }));
      } else {
        matches.push({ at, len, name: baseName });
      }
    }
    // Rango global → rangos POR LÍNEA. El hueco NOMBRADO va en la línea con el run
    // de leaders más largo del match (ahí está el espacio para escribir); el resto
    // del match (el label "[…]", los puntos de otra línea) se DESCARTA.
    for (const mt of matches) {
      const ranges: Array<{ li: number; from: number; to: number; lead: number }> = [];
      for (let k = 0; k < lines.length; k++) {
        const a = Math.max(mt.at, starts[k]!), b = Math.min(mt.at + mt.len, starts[k]! + lines[k]!.text.length);
        if (b <= a) continue;
        const lead = Math.max(0, ...[...lines[k]!.text.slice(a - starts[k]!, b - starts[k]!).matchAll(/[.…_]{2,}/g)].map(m => m[0].length));
        ranges.push({ li: k, from: a - starts[k]!, to: b - starts[k]!, lead });
      }
      const main = ranges.reduce((best, r2) => (r2.lead > best.lead ? r2 : best), ranges[0]!);
      for (const r2 of ranges) {
        // Un rango ya cubierto por otro hueco (frases-contexto SOLAPADAS del
        // LLM: "XXXXXX de XXXX" + "de XXXX hasta") no duplica: se saltea.
        if (holes.some(h => h.li === r2.li && r2.from < h.to && r2.to > h.from)) continue;
        if (r2 !== main) { holes.push({ li: r2.li, from: r2.from, to: r2.to, name: '', target: 0, drop: true }); continue; }
        // keep = tiene un run de LEADERS: colocación DIRECTA sobre su rect, texto
        // intacto (aunque sea angosto — reflowear párrafos con estilos ricos por
        // un leader chico demostró romper más de lo que arregla). rewrite =
        // RELLENO sin leaders (XXXX, xxx, ***): se reescribe como GAP EN BLANCO
        // al ancho útil del dato y el párrafo se reacomoda (reflow).
        const cx = charXOf(lines[r2.li]!);
        const existingW = (cx[r2.to] ?? cx[cx.length - 1]!) - (cx[r2.from] ?? 0);
        const desired = targetWidthFor(mt.name, f.width, ctx.fontSize, ctx.hints);
        const keep = r2.lead >= 2;
        holes.push({ li: r2.li, from: r2.from, to: r2.to, name: mt.name, target: keep ? (existingW >= desired * 0.9 ? existingW : Math.max(existingW, 25)) : desired, rewrite: !keep });
      }
      gOff = at + len;
    }
  }

  // BARRIDO: si el pedido incluía leaders — o si vamos a REFLOWEAR (hay
  // rewrites) — NINGÚN run de placeholder del párrafo puede quedar huérfano: el
  // LLM suele pasar solo algunos (o uno por llamada) y la segunda llamada choca
  // con el anti-recall (el párrafo ya quedó restyled). El reflow es UNO solo por
  // párrafo: se convierten todos acá, con nombre automático los no nombrados.
  const willReflow = holes.some(h => h.rewrite && !h.drop);
  if (fields.some(f => /[.…_]{2,}/.test(f.placeholder)) || willReflow) {
    const isWord = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}]/u.test(ch);
    for (let k = 0; k < lines.length; k++) {
      for (const m of lines[k]!.text.matchAll(/[.…_]{4,}/g)) {
        const a = m.index!, b = a + m[0].length;
        if (holes.some(h => h.li === k && a < h.to && b > h.from)) continue;
        const cx = charXOf(lines[k]!);
        const existingW = (cx[b] ?? cx[cx.length - 1]!) - (cx[a] ?? 0);
        const desired = targetWidthFor('', undefined, ctx.fontSize, ctx.hints);
        holes.push({ li: k, from: a, to: b, name: `campo_${holes.length + 1}`, target: existingW >= desired * 0.9 ? existingW : desired });
      }
      // Con reflow en marcha, también los runs de RELLENO (XXXX/xxx/***) no
      // pasados se convierten AHORA — si quedaran, serían inalcanzables (la
      // próxima llamada da ↩︎) y quedarían X's sueltas en el documento.
      if (willReflow) {
        for (const m of lines[k]!.text.matchAll(/[xX*]{2,}/g)) {
          const a = m.index!, b = a + m[0].length;
          if (isWord(lines[k]!.text[a - 1]) || isWord(lines[k]!.text[b])) continue;
          if (holes.some(h => h.li === k && a < h.to && b > h.from)) continue;
          holes.push({ li: k, from: a, to: b, name: `campo_${holes.length + 1}`, target: targetWidthFor('', undefined, ctx.fontSize, ctx.hints), rewrite: true });
        }
      }
    }
    holes.sort((a, b) => a.li - b.li || a.from - b.from);
  }

  // NADA localizado (ni siquiera el barrido encontró huecos): recién acá es un
  // error — con al menos UN hueco, los placeholders mal citados van como nota
  // (el barrido suele cubrirlos igual) y el resto del grupo procede.
  if (!holes.some(h => !h.drop && h.name)) {
    const miss = matchNotes[0] ? matchNotes[0].replace(/^\(⚠ /, '').replace(/ — .*\)$/, '') : 'ningún placeholder localizado';
    return { fields: [], notes: matchNotes, nothingNew: true, error: `${miss} en el párrafo${ctx.nodeId ? ` de ${ctx.nodeId}` : ''} (usá el texto EXACTO, en orden de lectura).` };
  }

  // Modo REESCRITURA: la colocación directa no aplica — el caller corre el
  // reflow (los huecos se emiten como gaps EN BLANCO) y coloca con
  // {@link placeFieldsInGaps} sobre el preview horneado.
  if (willReflow) return { fields: [], notes: matchNotes, nothingNew: false, needsReflow: true, holes };

  // ── COLOCACIÓN DIRECTA, SIN REFLOW ────────────────────────────────────────
  // El placeholder YA ocupa su lugar: el campo se crea EXACTAMENTE sobre ese rect
  // (charXOf = x real de cada glifo) y el texto NO se toca — los puntitos quedan
  // debajo del campo, como en un formulario de papel. Cero reescritura = cero
  // corrupción, e IDEMPOTENTE: si el rect ya tiene un widget (del documento o de
  // esta sesión), se saltea.
  const out: FieldPlacement[] = [];
  const queued: OccupiedRect[] = [...ctx.queuedFields];
  const notes: string[] = [...matchNotes];
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
    // DEFENSA: un campo cubre el HUECO, nunca letras. El LLM puede marcar un rango
    // que invade la etiqueta contigua — sobre todo cuando el PDF (Word justificado)
    // pega la palabra a los leaders en el mismo run ("......Direcci"). Si dentro
    // de [from,to] hay glifos de relleno, recortamos al run de relleno MÁS LARGO;
    // así el campo cae sobre los puntos y no sobre "Direcci". No-op cuando el hueco
    // ya es todo relleno (el caso normal) → cero cambio para los tests existentes.
    let cf = h.from, ct = h.to;
    const seg = line.text.slice(h.from, h.to);
    const fills = [...seg.matchAll(/[.…_]+[.…_\s]*/g)];
    if (fills.length) {
      const longest = fills.reduce((a, b) => (b[0].length > a[0].length ? b : a));
      cf = h.from + longest.index!;
      ct = cf + longest[0].trimEnd().length;
    }
    const x0 = cx[cf] ?? line.seg.x;
    const x1 = cx[ct] ?? cx[cx.length - 1] ?? x0;
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

/**
 * COLOCACIÓN POST-REFLOW (modo reescritura): los huecos fueron emitidos como
 * GAPS EN BLANCO (cero glifos — ver rowRuns en reflow.ts) y acá se convierten
 * en campos midiendo los GAPS GRANDES entre runs consecutivos del preview
 * horneado. Los bordes de run son geometría EXACTA de la extracción → el campo
 * queda ACOTADO por el texto vecino: no puede pisarlo por construcción. Pura:
 * cero I/O — recibe el rePage que reflowApply ya re-extrajo.
 *
 * Pairing hueco↔gap por CERCANÍA al x ESPERADO del layout (acumulando anchos
 * estimados): el índice puro se desfasa si la fila trae un gap ajeno (p. ej. el
 * espacio entre columnas a la misma baseline). Un hueco al FINAL de la fila no
 * tiene run derecho: se cierra contra el ancho esperado del layout.
 */
export function placeFieldsInGaps(
  para: Paragraph,
  sX: number,
  layout: ReflowTok[][],
  rePage: PageGraph | undefined,
  scale: number,
  ctx: MatchContext,
): { fields: FieldPlacement[]; notes: string[] } {
  const { lines, leading, paraBottom, rightEdge, spaceW } = para;
  const fields: FieldPlacement[] = [];
  const notes: string[] = [];
  const queued: OccupiedRect[] = [...ctx.queuedFields];
  const r2v = (v: number): number => Math.round(v * 100) / 100;
  const overlapsExisting = (x: number, y: number, w: number): boolean => {
    const near = (wx: number, wy: number, ww: number): boolean => x < wx + ww && x + w > wx && Math.abs(wy - y) < 8;
    if (ctx.existingWidgets.some(wd => near(wd.x, wd.y, wd.width))) return true;
    return queued.some(c => near(c.x, c.y, c.width));
  };
  const rowBl = (k: number): number => (k < lines.length ? lines[k]!.baseline : paraBottom - leading * (k - lines.length + 1));
  for (let k = 0; k < layout.length; k++) {
    const rowHoles = layout[k]!.filter(t => t.kind === 'hole' && !!t.hole?.name && !t.hole.drop);
    if (!rowHoles.length) continue;
    const bl = rowBl(k);
    // La fila REAL horneada: RUNS re-extraídos a esa baseline (por baseline de
    // RUN, no de segmento: un bloque multilínea reporta la de su 1ra línea).
    const flat = (rePage?.segments ?? [])
      .flatMap(sg => sg.runs)
      .filter(r => Math.abs(r.baseline - bl) < 6 && r.x >= sX - 3)
      .sort((a, b) => a.x - b.x);
    const rowX0 = k < lines.length ? lines[k]!.x : sX;
    // Los huecos son los GAPS ≥15pt entre runs (un espacio justificado nunca
    // llega; un hueco emite ≥25pt).
    const rects: Array<{ x0: number; x1: number }> = [];
    {
      let prevEnd = rowX0;
      for (const r of flat) {
        if (r.x - prevEnd >= 15) rects.push({ x0: prevEnd, x1: r.x });
        prevEnd = Math.max(prevEnd, r.x + r.width);
      }
      const lastTok = layout[k]![layout[k]!.length - 1];
      if (lastTok?.kind === 'hole' && !!lastTok.hole?.name && !lastTok.hole.drop) {
        const w = Math.max(25, lastTok.hole.target * scale);
        rects.push({ x0: prevEnd + 2, x1: Math.min(prevEnd + 2 + w, rightEdge) });
      }
    }
    const expected: number[] = [];
    {
      let cur = rowX0;
      for (const t of layout[k]!) {
        const w = t.kind === 'hole' ? Math.max(25, t.hole!.target * scale) : t.w;
        if (t.kind === 'hole' && !!t.hole?.name && !t.hole.drop) expected.push(cur + w / 2);
        cur += w + spaceW;
      }
    }
    const claimed = new Set<number>();
    rowHoles.forEach((t, j) => {
      let best = -1, bd = Infinity;
      rects.forEach((rc, ri) => {
        if (claimed.has(ri)) return;
        const d = Math.abs((rc.x0 + rc.x1) / 2 - (expected[j] ?? rowX0));
        if (d < bd) { bd = d; best = ri; }
      });
      if (best < 0) { notes.push(`(⚠ ${t.hole!.name}: no encontré su hueco en el preview horneado)`); return; }
      claimed.add(best);
      const rc = rects[best]!;
      // 1pt de inset por lado: el campo no toca los glifos vecinos.
      const x = rc.x0 + 1, w = Math.max(14, rc.x1 - rc.x0 - 2), y = bl - 2;
      if (overlapsExisting(x, y, w)) { notes.push(`(↩︎ ${t.hole!.name} ya tiene campo ahí — salteado)`); return; }
      const f: FieldPlacement = { fieldType: 'text', page: ctx.page, x: r2v(x), y: r2v(y), width: r2v(w), height: r2v(ctx.fontSize + 3), name: t.hole!.name };
      fields.push(f);
      queued.push({ x: f.x, y: f.y, width: f.width });
      notes.push(`${t.hole!.name} @(${Math.round(x)},${Math.round(y)}) ${Math.round(w)}pt`);
    });
  }
  return { fields, notes };
}
