/**
 * API pública de @aldus/agent — y del paquete npm `aldus` (su dist/index.js
 * bundlea este archivo). Es LA superficie que consume un producto host
 * (p.ej. un e-sign): motor puro, bytes in → bytes/datos out, sin DB ni auth.
 *
 * Organizada por los tres momentos de un documento:
 *   LEER      — grafo tipado, texto, campos, metadatos, anclas por texto.
 *   EDITAR    — sesión de ediciones acumuladas + bake in-situ, o primitivas
 *               directas (campos nuevos, imágenes, watermark, links…).
 *   FINALIZAR — llenar valores, APLANAR.
 * El sellado criptográfico (PAdES/timestamping/audit) es del host, no del motor.
 *
 * EL AGENTE (reescritura por fases — AGENT-PLAN.md): dos agentes sobre un
 * registry de tools multi-bindeadas. El host extiende bindeando sus propias
 * {@link IAgentTool} en el container (OCP) — no hay formato aparte de host-tool.
 */

// ── LEER ────────────────────────────────────────────────────────────────────
export { loadDoc, graphFromBytes } from './graph.js';
export type { DocGraph } from './graph.js';
export { serializeDoc } from './serialize.js';
export { locateText } from '@aldus/core';
export type { TextAnchor, PageGraph, SegmentNode, LineNode, TextRunNode, ImageNode, WidgetNode, WidgetKind, HighlightNode, LinkNode, ShapeNode } from '@aldus/core';
export { readPdfInfo, isPdf } from '@aldus/core/bake';
export type { PdfInfo } from '@aldus/core/bake';
// Formularios DETERMINÍSTICOS (sin LLM): leer campos+valores+posiciones.
export { readFormFields } from '@aldus/core/bake';
export type { FormField } from '@aldus/core/bake';

// ── EDITAR ──────────────────────────────────────────────────────────────────
export { EditSession } from './session/EditSession.js';
export type { TurnFinish } from './session/EditSession.js';
export { NodeIndex } from './session/NodeIndex.js';
export { bake, bakeSegmentEdits } from '@aldus/core/bake';
export type { BakeResult } from '@aldus/core/bake';
export {
  addFormField, insertImage, addText, addWatermark, addHeaderFooter,
  addHighlight, addLink, removeLink, setFieldOptions, addRadioOption,
  FIELD_DEFAULT_SIZE,
} from '@aldus/core/bake';
export type { NewFieldSpec, NewImageSpec, NewTextSpec } from '@aldus/core/bake';
// COMPONER una página desde bloques estructurados (lo que usa replace_page): el
// host describe el contenido, el layout (tipografía/wrap/márgenes) lo hace acá.
export { composePageBlocks } from '@aldus/core/bake';
export type { PageBlock, ComposeResult } from '@aldus/core/bake';

// ── FINALIZAR ───────────────────────────────────────────────────────────────
export { setFieldValues, flattenForm } from '@aldus/core/bake';
export type { FlattenResult } from '@aldus/core/bake';

// ── EL AGENTE ───────────────────────────────────────────────────────────────
// El contrato de tool (nativas y del host: UN solo formato) + el registry.
export { IAgentTool } from './tools/contract.js';
export type { AgentLevel, ToolContext } from './tools/contract.js';
export { IToolRegistry, ToolRegistry } from './tools/registry.js';
export type { ToolCode, ToolOutcome } from './tools/registry.js';
// Los DOS agentes: reader (contenido inline, barato) y editor (grafo scoped,
// fuerte). El host cablea la puerta reader→editor vía ReadTurnOpts.editor.
export { readTurn } from './agents/reader.js';
export type { ReadTurnOpts, ReadTurnResult, EditRoute } from './agents/reader.js';
export { editTurn, editPages } from './agents/editor.js';
export type { EditTurnOpts, EditTurnResult } from './agents/editor.js';
export { createMutex } from './agents/mutex.js';
export type { Mutex } from './agents/mutex.js';
export { transportFor } from './agents/transports.js';
// Composition root: el host lo crea, bindea lo suyo, y corre.
export { createAgentContainer } from './ioc.js';
export type { AgentContainerOpts } from './ioc.js';
// Config inyectable (los tests pasan la suya; los hosts usan el default).
export { IAgentConfig, loadAgentConfig, isOpenRouterModel } from './config.js';
export type { IAgentOpenRouterConfig } from './config.js';
// El seam de STREAMING de un host: el server escribe NDJSON, el CLI stdout,
// un test un callback — misma orquestación, distinto canal.
export { IAgentEventSink, CallbackSink } from './transport/sink.js';
export type { AgentWireEvent, TurnDoneEvent, TurnErrorEvent, HostEvent } from './transport/sink.js';
// El contrato ILlmTransport + los 2 transportes (se inyectan por config).
export { ILlmTransport } from './transport/transport.js';
export type { PassRequest, PassResult, PassTool, AgentEvent, AgentRole, ChatTurn } from './transport/transport.js';
export { ClaudeSdkTransport } from './transport/claudeSdk.js';
export { OpenRouterTransport } from './transport/openRouter.js';

// ── HOST NODE ───────────────────────────────────────────────────────────────
// Fuentes sustitutas REALES (original del sistema / gemela métrica descargada):
// el host Node lo llama UNA vez al boot. El browser no debe importar esto.
export { registerNodeFontProviders } from '@aldus/core/node';
// Editor visual local en una llamada (el ejemplo edit-in-browser ES esto).
export { openInEditor, openFile } from './host/openInEditor.js';
