/**
 * contract.ts — EL contrato de tool del agente (art-of-code C2: interface +
 * Symbol del mismo nombre; los consumidores dependen del token, nunca de una
 * clase concreta).
 *
 * UNA tool = UN binding de {@link IAgentTool} en el composition root (C4,
 * multi-binding). Esto vale igual para las tools nativas de Aldus (tools/read,
 * tools/edit) y para las del HOST (Signwax bindea las suyas — firmantes,
 * envíos… — en su propio container SIN tocar este paquete: OCP).
 *
 * `level` decide qué agente la ve:
 *   - 'reader'  → el agente barato de lectura/consulta (Gemini por default).
 *   - 'editor'  → el agente fuerte de edición (solo entra vía edit_document).
 *   - 'both'    → ambos.
 */
import type { z } from 'zod';
import { createToken } from '@aldus/core';
import type { EditSession } from '../session/EditSession.js';
import type { DocGraph } from '../graph.js';

export type AgentLevel = 'reader' | 'editor' | 'both';

/** Lo que una tool recibe para trabajar. Las tools del host ignoran doc/session
 *  y cierran sobre su propio estado (DB, docId) — `emit` es su canal de eventos
 *  hacia el wire del turno (cards, navegación…). */
export interface ToolContext {
  doc: DocGraph;
  session: EditSession;
  /** Evento de dominio del host → viaja al sink como `{type:'host', name, data}`. */
  emit(name: string, data: unknown): void;
}

/**
 * Contexto para un turno SIN documento (chat org-level del host: "¿qué
 * documentos esperan mi firma?"). Las tools del host cierran sobre su propio
 * estado y nunca tocan doc/session; si una tool nativa de edición llegara a
 * correr acá, el getter tira un error CLARO que el catch central del registry
 * convierte en el ⚠️ estructurado para el modelo — nunca un undefined mudo.
 */
export function docLessContext(emit: ToolContext['emit']): ToolContext {
  const refuse = (what: string): never => {
    throw new Error(`turno sin documento: esta tool requiere ${what} (abrí un documento para editarlo)`);
  };
  return {
    get doc(): DocGraph { return refuse('el grafo del documento'); },
    get session(): EditSession { return refuse('una sesión de edición'); },
    emit,
  };
}

export interface IAgentTool {
  /** snake_case, único en el registry. */
  name: string;
  description: string;
  level: AgentLevel;
  /** Shape zod de los argumentos: valida en el registry y deriva el JSON
   *  Schema que ve el LLM (`z.toJSONSchema`) — una sola fuente. */
  shape: z.ZodRawShape;
  /** OPCIONAL: JSON Schema CRUDO de los args, para hosts cuyas tools ya viven
   *  en JSON Schema (p. ej. las de dominio de Signwax). Cuando está, gana sobre
   *  `shape` para lo que ve el LLM y el registry NO re-valida con zod — la tool
   *  del host valida sus propios args (ya lo hacía antes de migrar). */
  parameters?: Record<string, unknown>;
  /**
   * Ejecuta y devuelve el protocolo de texto para el LLM:
   *   '✓ …' hecho · '↩︎ …' no aplicaba (skip) · '⚠️ …' problema (reintentable).
   * Un THROW es un bug (internal): el registry lo captura, loguea el stack y
   * al modelo le llega un mensaje genérico — nunca el stack.
   */
  run(ctx: ToolContext, args: Record<string, unknown>): string | Promise<string>;
}
export const IAgentTool = createToken<IAgentTool>('IAgentTool');
