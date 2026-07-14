/**
 * tools.ts — las tools de MUTACIÓN del agente, como DATA (una sola fuente).
 * Cada def tiene nombre, descripción, un shape zod y un `run(session, args)` que
 * devuelve la confirmación (protocolo ✓/⚠️/↩︎ — contrato con el LLM, intacto).
 * El path suscripción las expone al Claude Agent SDK como server MCP; el path
 * OpenRouter las serializa a formato OpenAI. AMBOS ejecutan por `runTool`.
 *
 * v2 (audit-agent §3.3): `runTool` es el ÚNICO catch site — valida los args con
 * `z.object(shape).parse` (MISMO contrato en ambos transportes; v1 no validaba en
 * OpenRouter) y produce un {@link ToolOutcome} estructurado DEBAJO del protocolo
 * de strings; un error de programación (Internal) LOGUEA el stack (v1 lo perdía).
 */
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createLogger } from '@aldus/core';
import type { EditSession } from '../session/EditSession.js';

const log = createLogger('aldus:tools');

const FIELD_TYPES = ['text', 'checkbox', 'radio', 'select', 'list', 'button', 'signature'] as const;

/** Una tool como data: shape zod (para MCP y para JSON-Schema) + handler. El
 *  handler puede ser async (p. ej. placeholders_to_fields hornea un preview
 *  para medir el layout real antes de ubicar los campos). */
export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run: (session: EditSession, args: Record<string, unknown>) => string | Promise<string>;
}

const a = (o: Record<string, unknown>) => o; // alias legible para args tipados por uso

export const TOOL_DEFS: ToolDef[] = [
  // ── texto existente ──
  {
    name: 'edit_text',
    description: 'Reemplaza el CONTENIDO de un nodo de texto (conserva su estilo). Si el texto nuevo es MÁS LARGO que el renglón, el párrafo se reconstruye solo (reflow) — no calcules nada, escribí el texto final.',
    shape: { id: z.string().describe('id del nodo de texto, p. ej. p1-y708-x72'), text: z.string().describe('texto nuevo') },
    run: (s, { id, text }) => s.editText(id as string, text as string),
  },
  {
    name: 'replace_paragraph',
    description: 'Reemplaza un PÁRRAFO o una CLÁUSULA ENTERA por texto nuevo, en UNA SOLA llamada — el código re-envuelve al ancho real, re-emite los renglones y corre el contenido inferior (baja si crece, SUBE y cierra el hueco si se achica, tragando los gaps entre párrafos). Si la cláusula tiene VARIOS párrafos, pasá end_id = el id de su ÚLTIMA línea (UNA llamada cubre todo el bloque). Usala SIEMPRE para "reemplazá el punto/la cláusula N" — JAMÁS edit_text + delete_text renglón por renglón, y NO toques la zona después (ya queda acomodada).',
    shape: {
      id: z.string().describe('id de la PRIMERA línea del párrafo/cláusula'),
      text: z.string().describe('el texto COMPLETO nuevo'),
      end_id: z.string().optional().describe('id de la ÚLTIMA línea del bloque (cláusulas de varios párrafos) — misma columna que id'),
    },
    run: (s, { id, text, end_id }) => s.replaceParagraph(id as string, text as string, end_id as string | undefined),
  },
  {
    name: 'set_text_style',
    description: 'Pone o saca NEGRITA/ITÁLICA a un nodo de texto entero. Si el PDF no trae embebida esa variante de la fuente, se usa la estándar equivalente (se reporta).',
    shape: { id: z.string(), bold: z.boolean().optional(), italic: z.boolean().optional() },
    run: (s, { id, bold, italic }) => s.styleText(id as string, { bold: bold as boolean | undefined, italic: italic as boolean | undefined }),
  },
  {
    name: 'move_text',
    description: 'Mueve un nodo de texto. Coordenadas en puntos PDF: x→derecha, y (baseline)→arriba, origen abajo-izquierda. Omití la coordenada que no cambia.',
    shape: { id: z.string(), x: z.number().optional(), y: z.number().optional() },
    run: (s, { id, x, y }) => s.moveText(id as string, x as number | undefined, y as number | undefined),
  },
  {
    name: 'set_text_color',
    description: 'Cambia el color de un nodo de texto (hex #rrggbb).',
    shape: { id: z.string(), color: z.string().describe('#rrggbb') },
    run: (s, { id, color }) => s.colorText(id as string, color as string),
  },
  {
    name: 'set_text_size',
    description: 'Cambia el tamaño de fuente de un nodo de texto (puntos).',
    shape: { id: z.string(), size: z.number().positive() },
    run: (s, { id, size }) => s.resizeText(id as string, size as number),
  },
  {
    name: 'delete_text',
    description: 'Elimina un nodo de texto del documento.',
    shape: { id: z.string() },
    run: (s, { id }) => s.deleteText(id as string),
  },

  // ── imagen existente ──
  {
    name: 'move_image',
    description: 'Mueve y/o escala una imagen. Coordenadas/tamaño en puntos PDF (origen abajo-izquierda). Omití lo que no cambia.',
    shape: { id: z.string(), x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional() },
    run: (s, { id, x, y, width, height }) => s.moveImage(id as string, a({ x, y, width, height })),
  },
  {
    name: 'delete_image',
    description: 'Elimina una imagen del documento.',
    shape: { id: z.string() },
    run: (s, { id }) => s.deleteImage(id as string),
  },

  // ── resaltados (/Annots) ──
  {
    name: 'highlight_text',
    description: 'Resalta (marcador) un nodo de texto EXISTENTE por su id. El resaltado cubre el texto y lo sigue si lo movés. Color hex opcional (default amarillo).',
    shape: { id: z.string().describe('id del nodo de texto a resaltar'), color: z.string().optional().describe('#rrggbb') },
    run: (s, { id, color }) => s.highlightText(id as string, color as string | undefined),
  },
  {
    name: 'set_highlight_color',
    description: 'Cambia el color de un resaltado YA EXISTENTE (id de highlight del grafo, p. ej. p1-hl0). Hex #rrggbb.',
    shape: { id: z.string(), color: z.string().describe('#rrggbb') },
    run: (s, { id, color }) => s.recolorHighlight(id as string, color as string),
  },
  {
    name: 'delete_highlight',
    description: 'Elimina un resaltado existente (id de highlight del grafo).',
    shape: { id: z.string() },
    run: (s, { id }) => s.deleteHighlight(id as string),
  },

  // ── links (/Annots) ──
  {
    name: 'add_link',
    description: 'Pone un LINK clickeable sobre un nodo de texto EXISTENTE (por su id) hacia una URL.',
    shape: { id: z.string().describe('id del nodo de texto'), url: z.string().describe('URL destino') },
    run: (s, { id, url }) => s.linkText(id as string, url as string),
  },
  {
    name: 'delete_link',
    description: 'Elimina un link existente (id de link del grafo, p. ej. p1-link0).',
    shape: { id: z.string() },
    run: (s, { id }) => s.deleteLink(id as string),
  },

  // ── creación de contenido nuevo ──
  {
    name: 'add_text',
    description: 'Agrega un párrafo de texto NUEVO. (x,y) = esquina superior-izquierda en puntos PDF (origen abajo-izq). Si la posición pisa texto existente, BAJA sola hasta un hueco libre (se reporta). Se re-extrae como un nodo editable.',
    shape: {
      page: z.number().int().min(1), x: z.number(), y: z.number(), text: z.string(),
      size: z.number().positive().optional(), bold: z.boolean().optional(), italic: z.boolean().optional(), color: z.string().optional().describe('#rrggbb'),
    },
    run: (s, { page, x, y, text, size, bold, italic, color }) =>
      s.addTextNode(a({ page, x, y, text, size, bold, italic, color }) as Parameters<EditSession['addTextNode']>[0]),
  },
  {
    name: 'insert_image',
    description: 'Inserta una imagen (PNG/JPEG) desde una RUTA de archivo local. (x,y) = esquina superior-izquierda en puntos PDF.',
    shape: { page: z.number().int().min(1), x: z.number(), y: z.number(), path: z.string().describe('ruta a un .png/.jpg local'), maxWidth: z.number().positive().optional() },
    run: (s, { page, x, y, path, maxWidth }) => s.insertImageFile(page as number, x as number, y as number, path as string, maxWidth as number | undefined),
  },
  {
    name: 'add_watermark',
    description: 'Marca de agua de texto diagonal en TODAS las páginas.',
    shape: { text: z.string(), color: z.string().optional().describe('#rrggbb'), opacity: z.number().min(0).max(1).optional() },
    run: (s, { text, color, opacity }) => s.watermark(text as string, color as string | undefined, opacity as number | undefined),
  },
  {
    name: 'add_header_footer',
    description: 'Agrega encabezado y/o pie de página (texto) y opcionalmente números de página, en todas las páginas.',
    shape: { header: z.string().optional(), footer: z.string().optional(), pageNumbers: z.boolean().optional() },
    run: (s, { header, footer, pageNumbers }) => s.headerFooter(a({ header, footer, pageNumbers })),
  },
  {
    name: 'add_form_field',
    description: 'Crea un campo de formulario nuevo (text/checkbox/radio/select/list/button/signature). (x,y) = esquina inferior-izquierda en puntos PDF.',
    shape: {
      type: z.enum(FIELD_TYPES), page: z.number().int().min(1), x: z.number(), y: z.number(),
      width: z.number().positive().optional(), height: z.number().positive().optional(), name: z.string().optional(),
    },
    run: (s, { type, page, x, y, width, height, name }) =>
      s.addField(type as (typeof FIELD_TYPES)[number], page as number, x as number, y as number, width as number | undefined, height as number | undefined, name as string | undefined),
  },
  {
    name: 'placeholders_to_fields',
    description:
      'Convierte placeholders (leaders ...../____, XXXX, o huecos que VOS detectás) en campos de formulario, creando cada ' +
      'campo EXACTAMENTE SOBRE el rect del placeholder — el texto del documento NO se modifica (cero reflow, imposible ' +
      'pisar o corromper nada). Llamala UNA VEZ por párrafo con TODOS sus placeholders en fields[], en orden de lectura. ' +
      'Si el pedido es de leaders (…/./_), la tool convierte TODOS los runs de leaders del párrafo aunque no los pases ' +
      '(nombre automático). Es idempotente: un placeholder que ya tiene campo se saltea. OJO: los textos entre corchetes ' +
      'descriptivos (p. ej. "[When the Agent is a company]", títulos "Alternative A [...]") NO son placeholders — no los ' +
      'pases. NO pases coordenadas; nunca edit_text+add_form_field a mano para esto.',
    shape: {
      id: z.string().describe('id del nodo de texto con los placeholders'),
      fields: z.array(z.object({
        placeholder: z.string().describe('el substring EXACTO del placeholder tal como aparece en el nodo, p. ej. "XXXXXXXXX" o "......."'),
        name: z.string().describe('nombre descriptivo del campo (snake_case), p. ej. "razon_social"'),
        width: z.number().positive().optional().describe('ignorado para la geometría (el campo mide lo que mide el placeholder impreso) — dejalo si querés documentar la intención.'),
      })).min(1).describe('un item por hueco, EN ORDEN de aparición'),
    },
    run: (s, { id, fields }) => s.placeholdersToFields(id as string, fields as Array<{ placeholder: string; name: string; width?: number }>),
  },
  {
    name: 'fill_field',
    description: 'COMPLETA un campo de formulario por su fieldName O por su id de widget (el [[id]] de la Lectura, p. ej. p1-w3): texto para text/select/radio; para checkbox pasá "true"/"false". Podés llamarla varias veces para completar todo el form.',
    shape: { name: z.string().describe('fieldName o id de widget (p1-w3)'), value: z.string().describe('valor (para checkbox: "true"/"false")') },
    run: (s, { name, value }) => s.fillField(name as string, value === 'true' ? true : value === 'false' ? false : (value as string)),
  },
  {
    name: 'fill_fields',
    description: 'Completa VARIOS campos DE UNA SOLA VEZ (preferí esta sobre llamar fill_field N veces — es mucho más rápido). Pasá una lista {name, value}; name = fieldName o id de widget ([[p1-w3]]); para checkbox value = "true"/"false".',
    shape: { fields: z.array(z.object({ name: z.string(), value: z.string() })).describe('lista de campos a completar') },
    run: (s, { fields }) => s.fillFields(
      (fields as Array<{ name: string; value: string }>).map(f => ({ name: f.name, value: f.value === 'true' ? true : f.value === 'false' ? false : f.value })),
    ),
  },
  {
    name: 'move_field',
    description: 'Mueve un campo de formulario EXISTENTE (id de widget del grafo). Coordenadas en puntos PDF; omití lo que no cambia.',
    shape: { id: z.string(), x: z.number().optional(), y: z.number().optional() },
    run: (s, { id, x, y }) => s.moveField(id as string, x as number | undefined, y as number | undefined),
  },
  {
    name: 'delete_field',
    description: 'Elimina un campo de formulario existente (id de widget del grafo).',
    shape: { id: z.string() },
    run: (s, { id }) => s.deleteField(id as string),
  },
];

/** Nombres calificados (mcp__<server>__<tool>) para allowedTools / permisos. */
export const TOOL_NAMES = TOOL_DEFS.map(d => `mcp__aldus__${d.name}`);

/* ── ToolOutcome: la estructura DEBAJO del protocolo ✓/⚠️/↩︎ ───────────────────
 * El string sigue siendo el contrato con el LLM (intacto); el outcome habilita
 * métricas y asserts de test que no dependan del texto en español. */

export type ToolCode = 'ok' | 'skipped' | 'warning' | 'bad_args' | 'internal' | 'unknown_tool';

export interface ToolOutcome {
  ok: boolean;
  code: ToolCode;
  /** ¿El LLM puede reintentar con éxito (args corregidos, otro nodo)? */
  retriable: boolean;
  /** El string ✓/⚠️/↩︎ que se le devuelve al modelo (NO se toca). */
  message: string;
}

/** Clasifica un mensaje de tool (protocolo de glifos) en un code coarse. El
 *  glifo líder ES el contrato: ✓ = ok, ↩︎ = salteado (no reintentar), ⚠️ = aviso. */
function classify(message: string): ToolOutcome {
  if (message.startsWith('↩︎')) return { ok: false, code: 'skipped', retriable: false, message };
  if (message.startsWith('⚠️')) return { ok: false, code: 'warning', retriable: true, message };
  return { ok: true, code: 'ok', retriable: false, message };
}

/** Tool del HOST (extensión OCP del agente): capacidades del dominio del host
 *  (firmantes, asignaciones, envíos…) que el EDITOR llama junto a las tools de
 *  Aldus. JSON Schema plano (formato OpenAI) para no imponerle zod al host, y
 *  `run(args)` sin sesión — el host cierra sobre su propio estado (DB, docId). */
export interface HostToolDef {
  name: string;
  description: string;
  /** JSON Schema del objeto de argumentos (va directo en `function.parameters`). */
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => string | Promise<string>;
}

/**
 * EJECUTA una tool contra la sesión y devuelve un {@link ToolOutcome}. ÚNICO
 * catch site del agente: valida los args (Aldus: `z.object(shape).parse`), corre,
 * y ante un throw arma el outcome — un `bad_args` (zod) es reintentable; un
 * `internal` (bug) loguea el stack (v1 lo perdía) y devuelve un mensaje genérico.
 */
export async function runToolOutcome(
  session: EditSession, name: string, args: Record<string, unknown>, extra: HostToolDef[] = [],
): Promise<ToolOutcome> {
  const d = TOOL_DEFS.find(x => x.name === name);
  if (d) {
    let parsed: Record<string, unknown>;
    try {
      parsed = z.object(d.shape).parse(args) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof z.ZodError ? err.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') : 'args inválidos';
      return { ok: false, code: 'bad_args', retriable: true, message: `⚠️ ${name}: ${detail}` };
    }
    try {
      return classify(await d.run(session, parsed));
    } catch (err) {
      log(`Internal en tool "${name}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return { ok: false, code: 'internal', retriable: false, message: `⚠️ ${name}: error` };
    }
  }
  const h = extra.find(x => x.name === name);
  if (h) {
    try {
      return classify(await h.run(args));
    } catch (err) {
      log(`Internal en host-tool "${name}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return { ok: false, code: 'internal', retriable: false, message: `⚠️ ${name}: error` };
    }
  }
  return { ok: false, code: 'unknown_tool', retriable: false, message: `⚠️ tool desconocida: ${name}` };
}

/** Ejecuta una tool y devuelve SOLO el string (protocolo ✓/⚠️/↩︎) para el LLM. */
export async function runTool(
  session: EditSession, name: string, args: Record<string, unknown>, extra: HostToolDef[] = [],
): Promise<string> {
  return (await runToolOutcome(session, name, args, extra)).message;
}

/** Servidor MCP para el Claude Agent SDK (path suscripción). Cada handler pasa
 *  por `runTool` → MISMO contrato de validación/catch que el path OpenRouter. */
export function buildToolServer(session: EditSession, extra: HostToolDef[] = []) {
  const ok = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  const tools = TOOL_DEFS.map(d =>
    tool(d.name, d.description, d.shape, async (args: Record<string, unknown>) => ok(await runTool(session, d.name, args, extra))),
  );
  return createSdkMcpServer({ name: 'aldus', version: '0.0.1', tools });
}

/* ── Router (arquitectura en dos niveles) ─────────────────────────────────────
 * El modelo CHAT (barato) NO edita: su única tool es edit_document, que delega
 * las modificaciones al modelo EDITOR con las páginas a tocar. */

export const ROUTE_SHAPE = {
  pages: z.array(z.number().int().min(1)).min(1)
    .describe('números de página del PDF donde van las ediciones, p. ej. [1,3,4]'),
  request: z.string()
    .describe('la instrucción COMPLETA y autocontenida para el editor (incluí todos los datos/valores que dio el usuario, en su idioma)'),
} satisfies z.ZodRawShape;
export const ROUTE_DESC =
  'Delegá TODA modificación del PDF (editar/mover/borrar texto, resaltar, links, imágenes, ' +
  'watermark, encabezados, campos de formulario, completar valores) al agente EDITOR. ' +
  'Llamala UNA sola vez con todas las páginas a tocar y el pedido completo.';

export interface RouteRequest { pages: number[]; request: string }

/** Servidor MCP con SOLO edit_document (fase chat del path suscripción). */
export function buildRouterServer(onRoute: (r: RouteRequest) => void) {
  return createSdkMcpServer({
    name: 'aldus',
    version: '0.0.1',
    tools: [
      tool('edit_document', ROUTE_DESC, ROUTE_SHAPE, async (args: Record<string, unknown>) => {
        onRoute({ pages: (args.pages as number[]) ?? [], request: String(args.request ?? '') });
        return { content: [{ type: 'text' as const, text: '✓ delegado al editor — las ediciones corren a continuación; no repitas la llamada.' }] };
      }),
    ],
  });
}

/* ── Serializadores OpenAI (path OpenRouter) ──────────────────────────────────
 * Las MISMAS defs, en formato tools de la API OpenAI-compatible. */

export type OpenAITool = { type: 'function'; function: { name: string; description: string; parameters: unknown } };

/** Tools de edición del EDITOR en formato OpenAI (function-calling).
 *  `extra` = tools del HOST, apendeadas a las de Aldus. */
export function openaiTools(extra: HostToolDef[] = []): OpenAITool[] {
  return [
    ...TOOL_DEFS.map(d => ({
      type: 'function' as const,
      function: { name: d.name, description: d.description, parameters: z.toJSONSchema(z.object(d.shape)) },
    })),
    ...extra.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
  ];
}

/** La ÚNICA tool del CHAT (edit_document) en formato OpenAI. */
export function openaiRouterTool(): OpenAITool {
  return { type: 'function', function: { name: 'edit_document', description: ROUTE_DESC, parameters: z.toJSONSchema(z.object(ROUTE_SHAPE)) } };
}
