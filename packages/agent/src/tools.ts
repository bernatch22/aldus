/**
 * tools.ts — las tools de MUTACIÓN que el agente puede invocar, atadas a una
 * EditSession. La LECTURA no es una tool: el documento entero ya va en el system
 * prompt. Cada tool referencia un id del grafo y devuelve una confirmación.
 */
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { EditSession } from './session.js';

/** Nombres calificados (mcp__<server>__<tool>) para allowedTools / permisos. */
export const TOOL_NAMES = [
  'edit_text', 'move_text', 'set_text_color', 'set_text_size', 'delete_text',
  'move_image', 'delete_image',
].map(n => `mcp__aldus__${n}`);

export function buildToolServer(session: EditSession) {
  const ok = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  const tools = [
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
  ];

  return createSdkMcpServer({ name: 'aldus', version: '0.0.1', tools });
}
