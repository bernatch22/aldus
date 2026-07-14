/**
 * API pública de @aldus/agent — y del paquete npm `aldus-pdf` (dist/index.js
 * bundlea este archivo). Es LA superficie que consume un producto host
 * (p.ej. un e-sign): motor puro, bytes in → bytes/datos out, sin DB ni auth.
 *
 * Organizada por los tres momentos de un documento:
 *   LEER      — grafo tipado, texto, campos, metadatos, anclas por texto.
 *   EDITAR    — sesión de ediciones acumuladas + bake in-situ, o primitivas
 *               directas (campos nuevos, imágenes, watermark, links…).
 *   FINALIZAR — llenar valores, APLANAR.
 * El sellado criptográfico (PAdES/timestamping/audit) es del host, no del motor.
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
export { NodeIndex } from './session/NodeIndex.js';
export { runTurn } from './runTurn.js';
export type { TurnResult, TurnOpts, AgentEvent, AgentRole } from './runTurn.js';
// El agente (two-level) sobre el contrato ILlmTransport + los 2 transportes.
export { ILlmTransport } from './transport/transport.js';
export type { PassRequest, PassResult, PassTool } from './transport/transport.js';
export { ClaudeSdkTransport } from './transport/claudeSdk.js';
export { OpenRouterTransport } from './transport/openRouter.js';
// Tools como DATA + su ejecución (ToolOutcome debajo del protocolo ✓/⚠️/↩︎) +
// la extensión OCP del host (tools de su dominio: firmantes, envíos…).
export { TOOL_DEFS, TOOL_NAMES, runTool, runToolOutcome, buildToolServer, buildRouterServer, openaiTools, openaiRouterTool } from './tools.js';
export type { ToolDef, ToolOutcome, ToolCode, HostToolDef, RouteRequest } from './tools.js';
// Config inyectable (los tests pasan la suya; los hosts usan el default).
export { loadAgentConfig, defaultAgentConfig } from './config.js';
export type { IAgentConfig, IAgentOpenRouterConfig, AgentProvider } from './config.js';
export { bake, bakeSegmentEdits } from '@aldus/core/bake';
export type { BakeResult } from '@aldus/core/bake';
export {
  addFormField, insertImage, addText, addWatermark, addHeaderFooter,
  addHighlight, addLink, removeLink, setFieldOptions, addRadioOption,
  FIELD_DEFAULT_SIZE,
} from '@aldus/core/bake';
export type { NewFieldSpec, NewImageSpec, NewTextSpec } from '@aldus/core/bake';

// ── FINALIZAR ───────────────────────────────────────────────────────────────
export { setFieldValues, flattenForm } from '@aldus/core/bake';
export type { FlattenResult } from '@aldus/core/bake';

// ── HOST NODE ───────────────────────────────────────────────────────────────
// Fuentes sustitutas REALES (original del sistema / gemela métrica descargada):
// el host Node lo llama UNA vez al boot. El browser no debe importar esto.
export { registerNodeFontProviders } from '@aldus/core/node';
