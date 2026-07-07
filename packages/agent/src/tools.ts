/**
 * tools.ts — las tools de MUTACIÓN que el agente puede invocar, atadas a una
 * EditSession. La LECTURA no es una tool: el documento entero ya va en el system
 * prompt. Cada tool referencia un id del grafo (o coordenadas para crear) y
 * devuelve una confirmación. Paridad con el editor humano: editar/mover/estilar/
 * borrar texto e imágenes; resaltar; linkear; insertar texto/imagen; marca de
 * agua; encabezado/pie; campos de formulario.
 */
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { EditSession } from './session.js';

/** Nombres calificados (mcp__<server>__<tool>) para allowedTools / permisos. */
export const TOOL_NAMES = [
  'edit_text', 'move_text', 'set_text_color', 'set_text_size', 'delete_text',
  'move_image', 'delete_image',
  'highlight_text', 'set_highlight_color', 'delete_highlight',
  'add_link', 'delete_link',
  'add_text', 'insert_image', 'add_watermark', 'add_header_footer',
  'add_form_field', 'fill_field', 'move_field', 'delete_field',
].map(n => `mcp__aldus__${n}`);

const FIELD_TYPES = ['text', 'checkbox', 'radio', 'select', 'list', 'button', 'signature'] as const;

export function buildToolServer(session: EditSession) {
  const ok = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  const tools = [
    // ── texto existente ──
    tool(
      'edit_text',
      'Reemplaza el CONTENIDO de un nodo de texto (conserva su estilo). Usá el id exacto del grafo.',
      { id: z.string().describe('id del nodo de texto, p. ej. p1-y708-x72'), text: z.string().describe('texto nuevo') },
      async ({ id, text }) => ok(session.editText(id, text)),
    ),
    tool(
      'move_text',
      'Mueve un nodo de texto. Coordenadas en puntos PDF: x→derecha, y (baseline)→arriba, origen abajo-izquierda. Omití la coordenada que no cambia.',
      { id: z.string(), x: z.number().optional(), y: z.number().optional() },
      async ({ id, x, y }) => ok(session.moveText(id, x, y)),
    ),
    tool(
      'set_text_color',
      'Cambia el color de un nodo de texto (hex #rrggbb).',
      { id: z.string(), color: z.string().describe('#rrggbb') },
      async ({ id, color }) => ok(session.colorText(id, color)),
    ),
    tool(
      'set_text_size',
      'Cambia el tamaño de fuente de un nodo de texto (puntos).',
      { id: z.string(), size: z.number().positive() },
      async ({ id, size }) => ok(session.resizeText(id, size)),
    ),
    tool(
      'delete_text',
      'Elimina un nodo de texto del documento.',
      { id: z.string() },
      async ({ id }) => ok(session.deleteText(id)),
    ),

    // ── imagen existente ──
    tool(
      'move_image',
      'Mueve y/o escala una imagen. Coordenadas/tamaño en puntos PDF (origen abajo-izquierda). Omití lo que no cambia.',
      { id: z.string(), x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional() },
      async ({ id, x, y, width, height }) => ok(session.moveImage(id, { x, y, width, height })),
    ),
    tool(
      'delete_image',
      'Elimina una imagen del documento.',
      { id: z.string() },
      async ({ id }) => ok(session.deleteImage(id)),
    ),

    // ── resaltados (/Annots) ──
    tool(
      'highlight_text',
      'Resalta (marcador) un nodo de texto EXISTENTE por su id. El resaltado cubre el texto y lo sigue si lo movés. Color hex opcional (default amarillo).',
      { id: z.string().describe('id del nodo de texto a resaltar'), color: z.string().optional().describe('#rrggbb') },
      async ({ id, color }) => ok(session.highlightText(id, color)),
    ),
    tool(
      'set_highlight_color',
      'Cambia el color de un resaltado YA EXISTENTE (id de highlight del grafo, p. ej. p1-hl0). Hex #rrggbb.',
      { id: z.string(), color: z.string().describe('#rrggbb') },
      async ({ id, color }) => ok(session.recolorHighlight(id, color)),
    ),
    tool(
      'delete_highlight',
      'Elimina un resaltado existente (id de highlight del grafo).',
      { id: z.string() },
      async ({ id }) => ok(session.deleteHighlight(id)),
    ),

    // ── links (/Annots) ──
    tool(
      'add_link',
      'Pone un LINK clickeable sobre un nodo de texto EXISTENTE (por su id) hacia una URL.',
      { id: z.string().describe('id del nodo de texto'), url: z.string().describe('URL destino') },
      async ({ id, url }) => ok(session.linkText(id, url)),
    ),
    tool(
      'delete_link',
      'Elimina un link existente (id de link del grafo, p. ej. p1-link0).',
      { id: z.string() },
      async ({ id }) => ok(session.deleteLink(id)),
    ),

    // ── creación de contenido nuevo ──
    tool(
      'add_text',
      'Agrega un párrafo de texto NUEVO. (x,y) = esquina superior-izquierda en puntos PDF (origen abajo-izq). Se re-extrae como un nodo editable.',
      {
        page: z.number().int().min(1), x: z.number(), y: z.number(), text: z.string(),
        size: z.number().positive().optional(), bold: z.boolean().optional(), italic: z.boolean().optional(), color: z.string().optional().describe('#rrggbb'),
      },
      async ({ page, x, y, text, size, bold, italic, color }) => ok(session.addTextNode({ page, x, y, text, size, bold, italic, color })),
    ),
    tool(
      'insert_image',
      'Inserta una imagen (PNG/JPEG) desde una RUTA de archivo local. (x,y) = esquina superior-izquierda en puntos PDF.',
      { page: z.number().int().min(1), x: z.number(), y: z.number(), path: z.string().describe('ruta a un .png/.jpg local'), maxWidth: z.number().positive().optional() },
      async ({ page, x, y, path, maxWidth }) => ok(session.insertImageFile(page, x, y, path, maxWidth)),
    ),
    tool(
      'add_watermark',
      'Marca de agua de texto diagonal en TODAS las páginas.',
      { text: z.string(), color: z.string().optional().describe('#rrggbb'), opacity: z.number().min(0).max(1).optional() },
      async ({ text, color, opacity }) => ok(session.watermark(text, color, opacity)),
    ),
    tool(
      'add_header_footer',
      'Agrega encabezado y/o pie de página (texto) y opcionalmente números de página, en todas las páginas.',
      { header: z.string().optional(), footer: z.string().optional(), pageNumbers: z.boolean().optional() },
      async ({ header, footer, pageNumbers }) => ok(session.headerFooter({ header, footer, pageNumbers })),
    ),
    tool(
      'add_form_field',
      'Crea un campo de formulario nuevo (text/checkbox/radio/select/list/button/signature). (x,y) = esquina inferior-izquierda en puntos PDF.',
      {
        type: z.enum(FIELD_TYPES), page: z.number().int().min(1), x: z.number(), y: z.number(),
        width: z.number().positive().optional(), height: z.number().positive().optional(), name: z.string().optional(),
      },
      async ({ type, page, x, y, width, height, name }) => ok(session.addField(type, page, x, y, width, height, name)),
    ),
    tool(
      'fill_field',
      'COMPLETA un campo de formulario por su NOMBRE (fieldName, no el id): texto para text/select/radio; para checkbox pasá "true"/"false". Podés llamarla varias veces para completar todo el form.',
      { name: z.string().describe('fieldName del campo'), value: z.string().describe('valor (para checkbox: "true"/"false")') },
      async ({ name, value }) => {
        const v = value === 'true' ? true : value === 'false' ? false : value;
        return ok(session.fillField(name, v));
      },
    ),
    tool(
      'move_field',
      'Mueve un campo de formulario EXISTENTE (id de widget del grafo). Coordenadas en puntos PDF; omití lo que no cambia.',
      { id: z.string(), x: z.number().optional(), y: z.number().optional() },
      async ({ id, x, y }) => ok(session.moveField(id, x, y)),
    ),
    tool(
      'delete_field',
      'Elimina un campo de formulario existente (id de widget del grafo).',
      { id: z.string() },
      async ({ id }) => ok(session.deleteField(id)),
    ),
  ];

  return createSdkMcpServer({ name: 'aldus', version: '0.0.1', tools });
}
