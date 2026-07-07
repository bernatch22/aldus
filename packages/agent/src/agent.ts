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
import { buildRouterServer, buildToolServer, type RouteRequest } from './tools.js';
import { serializeDoc } from './serialize.js';
import { config } from './config.js';
import type { DocGraph } from './graph.js';
import type { EditSession } from './session.js';

export function systemPrompt(doc: DocGraph, page?: number | number[]): string {
  const pages = doc.pages.length;
  const scoped = page == null ? null : (Array.isArray(page) ? page : [page]);
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
    '  · Formularios: las páginas con campos traen una sección "Lectura" — el',
    '    texto en orden con cada campo [[id]] intercalado DONDE CAE. Esa lectura',
    '    es LA fuente de verdad para saber qué va en cada campo (leé la oración',
    '    alrededor del [[id]], como un humano). Cada campo muestra su VALOR',
    '    actual (o "(vacío)") — para "extraer"/leer un form respondé desde el',
    '    grafo. Para COMPLETAR VARIOS campos usá fill_fields (UNA sola llamada con',
    '    la lista {name,value}) — mucho más rápido que fill_field N veces; usá',
    '    fill_field solo para uno. name = fieldName o el [[id]] de la Lectura.',
    '    Campos existentes: move_field, delete_field.',
    '    Un PDF PLANO (sin campos, con líneas/labels) se puede volver fillable:',
    '    add_form_field en cada hueco (mirá los labels y su geometría) y opcionalmente',
    '    fill_field. O simplemente escribir la respuesta con add_text al lado del label.',
    '',
    'Coordenadas: puntos PDF, origen ABAJO-IZQUIERDA, x→derecha, y→arriba. Para el',
    'texto la `y` es la baseline. El tamaño de cada página está en su encabezado.',
    'Para NO perder contenido, no coloques nada fuera de los límites de la página.',
    'LLENAR UNA LÍNEA "____" YA EXISTENTE (label + renglón): el valor se apoya',
    'ENCIMA del renglón, NO debajo. Usá la MISMA baseline del label de esa línea',
    '(su `y` exacto, o +2pt). NUNCA restes: y menor = el texto cae DEBAJO de la',
    'línea (mal). Si el hueco está a la derecha del label, x = x del label + su',
    'ancho + ~6pt. El texto va SOBRE los "____", no en otro renglón.',
    '',
    'CONVERTIR "XXXX"/"xxxx"/"____" EN INPUTS: usá placeholders_to_fields(id, names)',
    '— UNA sola llamada por nodo de texto; calcula posición y ancho EXACTOS de cada',
    'hueco desde el grafo y deja el estilo intacto. NO uses edit_text ni',
    'add_form_field a mano para esto, y NO pases coordenadas: solo el id y nombres',
    'descriptivos (mirá los labels alrededor de cada placeholder).',
    'MANTENÉ EL ESTILO en cualquier otra edición: nunca agregues bold/italic que el',
    'original no tenía. Si un reemplazo de texto queda MÁS ANCHO y va a solapar lo',
    'que sigue en el renglón, corré ese texto (move_text dx) o avisá en vez de pisar.',
    'Un "____" ya dibujado ya ES el campo: completá encima, no agregues otro.',
    '',
    'Respondé en el idioma del usuario, conciso. Si una edición es ambigua o el id',
    'no existe, decilo en vez de adivinar.',
    '',
    scoped
      ? `=== DOCUMENTO: ${doc.path} (${pages} páginas en total) — MOSTRANDO SOLO ${scoped.length === 1 ? `LA PÁGINA ${scoped[0]}` : `LAS PÁGINAS ${scoped.join(', ')}`}. Trabajá sobre esas páginas. ===`
      : `=== DOCUMENTO: ${doc.path} (${pages} ${pages === 1 ? 'página' : 'páginas'}) ===`,
    serializeDoc(doc, page),
  ].join('\n');
}

/**
 * System prompt del modelo CHAT (barato, primer nivel): describe/contesta desde
 * el grafo de la página actual, y ante CUALQUIER modificación delega en el
 * EDITOR vía edit_document({pages, request}) — no edita nada él mismo.
 */
export function chatSystemPrompt(doc: DocGraph, page?: number): string {
  const total = doc.pages.length;
  const current = page ?? 1;
  return [
    'Sos CASPER, el asistente del editor de PDF Aldus. Tenés embebido abajo el',
    `grafo de la página ${current} (el documento tiene ${total} en total; el usuario está viendo la ${current}).`,
    '',
    'Cómo trabajás:',
    '- PREGUNTAS sobre el contenido (resumir, extraer, listar campos, explicar) →',
    '  respondé DIRECTO leyendo el grafo, en el formato que pida (JSON, tabla…).',
    '- CUALQUIER MODIFICACIÓN del PDF (editar/mover/borrar texto, resaltar, links,',
    '  imágenes, watermark, encabezados, campos, completar formularios) → NO la',
    '  hagas vos: llamá edit_document UNA sola vez con TODO el pedido.',
    '  · pages = páginas a tocar, p. ej. [1] o [1,3,4]. Si el usuario no nombra',
    `    otra, es la que está viendo: [${current}].`,
    '  · request = la instrucción COMPLETA y autocontenida para el editor:',
    '    repetí todos los datos/valores/textos que dio el usuario, en su idioma.',
    '  Después de delegar, contale en UNA frase qué se está haciendo.',
    '- No inventes contenido de páginas que no ves. Si necesitás otra página para',
    '  RESPONDER una pregunta, pedile al usuario que la abra.',
    '',
    'Respondé en el idioma del usuario, conciso.',
    '',
    `=== DOCUMENTO: ${doc.path} — página ${current} de ${total} ===`,
    serializeDoc(doc, current),
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
export interface TurnOpts {
  doc: DocGraph;
  session: EditSession;
  prompt: string;
  resume?: string;
  /** Página que el usuario está viendo → el prompt se scopea a ESA (menos ruido). */
  page?: number;
  onEvent?: (ev: AgentEvent) => void;
}

export async function runTurn(opts: TurnOpts): Promise<TurnResult> {
  // OpenRouter (demo público): la suscripción no se puede exponer en un server.
  if (config.provider === 'openrouter') {
    const { runTurnOpenRouter } = await import('./openrouter.js');
    return runTurnOpenRouter(opts);
  }

  // ── FASE 1 — CHAT (barato, p. ej. Haiku): responde/describe; si hay que
  // modificar, delega vía edit_document({pages, request}). Sonnet no se gasta
  // en charla.
  let route: RouteRequest | null = null;
  let text = '';
  let sessionId: string | undefined;

  for await (const message of query({
    prompt: opts.prompt,
    options: {
      model: config.chatModel,
      systemPrompt: chatSystemPrompt(opts.doc, opts.page),
      mcpServers: { aldus: buildRouterServer(r => { route = r; }) },
      includePartialMessages: true,
      canUseTool: async (name, input) =>
        name === 'mcp__aldus__edit_document'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'El chat solo puede delegar con edit_document.' },
      maxTurns: 4,
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  })) {
    if (message.type === 'stream_event') {
      const ev = message.event as { type: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; name?: string } };
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        text += ev.delta.text;
        opts.onEvent?.({ type: 'text', delta: ev.delta.text });
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block.name === 'mcp__aldus__edit_document') {
        opts.onEvent?.({ type: 'tool', name: 'mcp__aldus__edit_document' });
      }
    } else if (message.type === 'result') {
      sessionId = message.session_id;
    }
  }

  if (!route) return { text, sessionId, toolCalls: 0 };

  // ── FASE 2 — EDITOR (fuerte, Sonnet): corre con los grafos de LAS PÁGINAS
  // pedidas por el chat y las tools reales de edición.
  const routed = route as RouteRequest;
  const pages = routed.pages.length ? routed.pages : (opts.page != null ? [opts.page] : undefined);
  const editorPrompt = `${opts.prompt}\n\n[Plan del asistente]: ${routed.request}`;
  const server = buildToolServer(opts.session);
  let toolCalls = 0;

  for await (const message of query({
    prompt: editorPrompt,
    options: {
      model: config.model,
      systemPrompt: systemPrompt(opts.doc, pages),
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
      // SIN resume: la fase editora es una conversación propia (el hilo del
      // chat vive en la fase 1 — su sessionId es el que se devuelve).
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
    }
  }
  return { text, sessionId, toolCalls };
}
