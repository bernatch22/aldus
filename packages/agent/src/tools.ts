/**
 * tools.ts — las tools de MUTACIÓN del agente, como DATA (una sola fuente) para
 * dos consumidores: el Claude Agent SDK (suscripción, MCP) y OpenRouter (API
 * OpenAI-compatible). Cada def tiene nombre, descripción, un shape zod y un
 * `run(session, args)` que devuelve la confirmación. La LECTURA no es una tool:
 * el documento entero ya va en el system prompt.
 */
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { EditSession } from './session.js';

const FIELD_TYPES = ['text', 'checkbox', 'radio', 'select', 'list', 'button', 'signature'] as const;

/** Una tool como data: shape zod (para MCP y para JSON-Schema) + handler. El
 *  handler puede ser async (p. ej. placeholders_to_fields hornea un preview
 *  para medir el layout real antes de ubicar los campos). */
interface ToolDef {
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
    description: 'Reemplaza el CONTENIDO de un nodo de texto (conserva su estilo). Usá el id exacto del grafo.',
    shape: { id: z.string().describe('id del nodo de texto, p. ej. p1-y708-x72'), text: z.string().describe('texto nuevo') },
    run: (s, { id, text }) => s.editText(id as string, text as string),
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
    description: 'Agrega un párrafo de texto NUEVO. (x,y) = esquina superior-izquierda en puntos PDF (origen abajo-izq). Se re-extrae como un nodo editable.',
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
      'Convierte los placeholders de UN nodo de texto (XXXX/xxx/***/____ que VOS detectás leyendo el texto) en campos ' +
      'de formulario, en UNA sola llamada. El código calcula la geometría EXACTA y reemplaza el placeholder por espacios — ' +
      'NO pasás coordenadas ni tocás el texto vos, y es IMPOSIBLE que el campo pise texto. SIEMPRE usá esta tool para ' +
      '"convertir en inputs", nunca edit_text + add_form_field a mano.',
    shape: {
      id: z.string().describe('id del nodo de texto con los placeholders'),
      fields: z.array(z.object({
        placeholder: z.string().describe('el substring EXACTO del placeholder tal como aparece en el nodo, p. ej. "XXXXXXXXX" o "xxxxxxx"'),
        name: z.string().describe('nombre descriptivo del campo (snake_case), p. ej. "razon_social"'),
      })).min(1).describe('un item por hueco, EN ORDEN de aparición'),
    },
    run: (s, { id, fields }) => s.placeholdersToFields(id as string, fields as Array<{ placeholder: string; name: string }>),
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

/** Servidor MCP para el Claude Agent SDK (path suscripción). */
export function buildToolServer(session: EditSession) {
  const ok = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  const tools = TOOL_DEFS.map(d =>
    tool(d.name, d.description, d.shape, async (args: Record<string, unknown>) => ok(await d.run(session, args))),
  );
  return createSdkMcpServer({ name: 'aldus', version: '0.0.1', tools });
}

/** Definiciones de tools en formato OpenAI (path OpenRouter). */
export function openaiTools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
  return TOOL_DEFS.map(d => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: z.toJSONSchema(z.object(d.shape)) },
  }));
}

/** Ejecuta una tool por nombre contra la sesión (path OpenRouter). */
export async function runTool(session: EditSession, name: string, args: Record<string, unknown>): Promise<string> {
  const d = TOOL_DEFS.find(x => x.name === name);
  if (!d) return `⚠️ tool desconocida: ${name}`;
  try { return await d.run(session, args); } catch (err) { return `⚠️ ${name}: ${err instanceof Error ? err.message : 'error'}`; }
}

/* ── Router (arquitectura en dos niveles) ─────────────────────────────────────
 * El modelo CHAT (barato) NO edita: su única tool es edit_document, que delega
 * las modificaciones al modelo EDITOR con las páginas a tocar. */

const ROUTE_SHAPE = {
  pages: z.array(z.number().int().min(1)).min(1)
    .describe('números de página del PDF donde van las ediciones, p. ej. [1,3,4]'),
  request: z.string()
    .describe('la instrucción COMPLETA y autocontenida para el editor (incluí todos los datos/valores que dio el usuario, en su idioma)'),
};
const ROUTE_DESC =
  'Delegá TODA modificación del PDF (editar/mover/borrar texto, resaltar, links, imágenes, ' +
  'watermark, encabezados, campos de formulario, completar valores) al agente EDITOR. ' +
  'Llamala UNA sola vez con todas las páginas a tocar y el pedido completo.';

export interface RouteRequest { pages: number[]; request: string }

/** Tool edit_document en formato OpenAI (fase chat del path OpenRouter). */
export function openaiRouterTool(): { type: 'function'; function: { name: string; description: string; parameters: unknown } } {
  return { type: 'function', function: { name: 'edit_document', description: ROUTE_DESC, parameters: z.toJSONSchema(z.object(ROUTE_SHAPE)) } };
}

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
