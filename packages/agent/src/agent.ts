/**
 * agent.ts — arma y corre un turno del agente Aldus con el Claude Agent SDK.
 * El documento COMPLETO va embebido en el system prompt; el agente responde
 * preguntas directo de ahí y edita con las tools. Multi-turno vía `resume`
 * (mismo session_id → conserva la conversación entre líneas del chat).
 *
 * Auth: por defecto usa la suscripción de Claude Code (corré SIN
 * ANTHROPIC_API_KEY). Modelo override con ALDUS_MODEL.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildToolServer } from './tools.js';
import { serializeDoc } from './serialize.js';
import { config } from './config.js';
import type { DocGraph } from './graph.js';
import type { EditSession } from './session.js';

function systemPrompt(doc: DocGraph): string {
  const pages = doc.pages.length;
  return [
    'Sos Aldus, un agente experto en documentos PDF. Tenés EMBEBIDO abajo el',
    'contenido completo del documento como un grafo. Sos CONSCIENTE de TODO:',
    'de cada nodo de texto conocés su `id`, posición (x, baseline), ancho×alto,',
    'tamaño de fuente, negrita/itálica y familia (y color si figura); de cada',
    'imagen, campo, resaltado y link su `id`, rect y datos. Usá esa geometría y',
    'ese estilo para ubicar y emparejar lo que hagas (p. ej. escribir alineado a',
    'un label, o crear un campo del tamaño justo).',
    '',
    'Cómo trabajás:',
    '- PREGUNTAS sobre el contenido → respondé directo leyendo el grafo. NO hay',
    '  tool de lectura: ya tenés todo el documento acá. Si el usuario pide los',
    '  datos en un formato (JSON, tabla, lista), devolvelos EXACTAMENTE así.',
    '- CAMBIOS → usá las tools referenciando los `id` EXACTOS del grafo. Podés',
    '  encadenar varias. No inventes ids. Tenés las MISMAS capacidades que un',
    '  humano en el editor:',
    '  · Texto existente: edit_text, move_text, set_text_color, set_text_size, delete_text.',
    '  · Imagen existente: move_image, delete_image.',
    '  · Resaltar: highlight_text (sobre un id de texto). Sobre resaltados que ya',
    '    existen: set_highlight_color, delete_highlight.',
    '  · Links: add_link (sobre un id de texto → URL), delete_link.',
    '  · Crear: add_text, insert_image (desde una ruta local), add_watermark,',
    '    add_header_footer, add_form_field (type = text/checkbox/radio/select/',
    '    list/button/signature — podés poner inputs NUEVOS: firmas, radios, checks…).',
    '  · Formularios: cada campo muestra su VALOR actual (o "(vacío)") — para',
    '    "extraer"/leer un form respondé desde el grafo. Para COMPLETAR usá',
    '    fill_field(fieldName, valor). Campos existentes: move_field, delete_field.',
    '    Un PDF PLANO (sin campos, con líneas/labels) se puede volver fillable:',
    '    add_form_field en cada hueco (mirá los labels y su geometría) y opcionalmente',
    '    fill_field. O simplemente escribir la respuesta con add_text al lado del label.',
    '',
    'Coordenadas: puntos PDF, origen ABAJO-IZQUIERDA, x→derecha, y→arriba. Para el',
    'texto la `y` es la baseline. El tamaño de cada página está en su encabezado.',
    'Para NO perder contenido, no coloques nada fuera de los límites de la página.',
    '',
    'Respondé en el idioma del usuario, conciso. Si una edición es ambigua o el id',
    'no existe, decilo en vez de adivinar.',
    '',
    `=== DOCUMENTO: ${doc.path} (${pages} ${pages === 1 ? 'página' : 'páginas'}) ===`,
    serializeDoc(doc),
  ].join('\n');
}

export interface TurnResult {
  text: string;
  sessionId?: string;
  toolCalls: number;
}

/** Eventos en vivo de un turno (para streamear al panel). */
export type AgentEvent =
  | { type: 'text'; delta: string }        // token(s) de texto del asistente
  | { type: 'tool'; name: string };        // arrancó una tool de edición

/** Corre un turno STREAMEADO. `resume` continúa la conversación previa (chat).
 *  `onEvent` recibe los deltas de texto y las tool calls a medida que ocurren. */
export async function runTurn(opts: {
  doc: DocGraph;
  session: EditSession;
  prompt: string;
  resume?: string;
  onEvent?: (ev: AgentEvent) => void;
}): Promise<TurnResult> {
  const server = buildToolServer(opts.session);
  let text = '';
  let sessionId: string | undefined;
  let toolCalls = 0;

  for await (const message of query({
    prompt: opts.prompt,
    options: {
      model: config.model,
      systemPrompt: systemPrompt(opts.doc),
      mcpServers: { aldus: server },
      // Deltas token a token → el panel muestra la respuesta escribiéndose y las
      // tools ejecutándose, en vez de quedarse mudo 20-40s en "Pensando".
      includePartialMessages: true,
      // En headless no hay prompt de permisos interactivo: `canUseTool` es el
      // ÚNICO gate — auto-aprueba las tools de Aldus y niega cualquier otra (sin
      // `allowedTools`, que las auto-aprobaría antes y shadowearía este callback).
      canUseTool: async (name, input) =>
        name.startsWith('mcp__aldus__')
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Aldus solo permite sus propias tools de edición.' },
      maxTurns: config.maxTurns,
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  })) {
    if (message.type === 'stream_event') {
      // Evento raw de Anthropic: deltas de texto y comienzo de tool_use.
      const ev = message.event as { type: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; name?: string } };
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        text += ev.delta.text;
        opts.onEvent?.({ type: 'text', delta: ev.delta.text });
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        const name = ev.content_block.name ?? 'tool';
        // Solo las tools de edición de Aldus cuentan/se muestran; las internas del
        // SDK (p. ej. ToolSearch, que canUseTool deniega) no son ruido para el UI.
        if (name.startsWith('mcp__aldus__')) {
          toolCalls++;
          opts.onEvent?.({ type: 'tool', name });
        }
      }
    } else if (message.type === 'result') {
      sessionId = message.session_id;
      // No pisamos `text` con message.result: el acumulado de deltas ya trae la
      // narrativa completa (texto intermedio entre tools incluido).
    }
  }
  return { text, sessionId, toolCalls };
}
