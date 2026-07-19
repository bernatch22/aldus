/**
 * config.ts — TODOS los knobs de entorno del agente, en un lugar.
 *
 * DOS AGENTES, cada uno con su modelo y su transporte:
 *   - READER  (barato y rápido): tiene el doc inline (input grande) y contesta;
 *              delega ediciones. Default flash-lite: solo rutea, no edita.
 *   - EDITOR  (fuerte): aplica ediciones con las tools sobre el grafo scoped.
 *              Default SONNET. Se probó Gemini (más rápido y barato) pero se
 *              sale del carril en documentos con placeholders: emula
 *              placeholders_to_fields a mano con edit_text (escribe espacios,
 *              "DD de MM de AAAA", "[Día de Inicio]") — texto que PARECE un
 *              hueco pero no se puede completar. El guardrail lo rechaza, pero
 *              el modelo insiste; Sonnet respeta la tool determinística.
 *
 * El TRANSPORTE se deriva del id del modelo — sin knob de provider:
 *   `vendor/slug` (contiene '/') → OpenRouter · `claude-*` → Claude Agent SDK.
 *
 * | Variable                | Default                      | Qué es                          |
 * |-------------------------|------------------------------|---------------------------------|
 * | ALDUS_READER_MODEL      | google/gemini-3.1-flash-lite | Modelo del reader (rutea).      |
 * | ALDUS_EDITOR_MODEL      | claude-sonnet-5              | Modelo del editor (edita).      |
 * | ALDUS_MAX_TURNS         | 24                           | Máx. turnos del editor.         |
 * | OPENROUTER_API_KEY      | (unset)                      | Bearer de OpenRouter.           |
 * | OPENROUTER_BASE_URL     | https://openrouter.ai/api/v1 | Base OpenAI-compatible.         |
 * | ANTHROPIC_API_KEY       | (unset)                      | UNSET = facturar la suscripción.|
 * | CLAUDE_CODE_OAUTH_TOKEN | (unset)                      | Token headless de la sub.       |
 */
import { createToken } from '@aldus/core';

/** OpenRouter: credenciales del endpoint OpenAI-compatible. */
export interface IAgentOpenRouterConfig {
  key: string;
  baseUrl: string;
}

export interface IAgentConfig {
  readerModel: string;
  editorModel: string;
  maxTurns: number;
  openrouter: IAgentOpenRouterConfig;
}
export const IAgentConfig = createToken<IAgentConfig>('IAgentConfig');

/** `vendor/slug` viaja por OpenRouter; lo demás por el Claude Agent SDK. */
export function isOpenRouterModel(model: string): boolean {
  return model.includes('/');
}

/** Lee TODOS los knobs del entorno una vez y arma la data plana. */
export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): IAgentConfig {
  return {
    readerModel: env.ALDUS_READER_MODEL || 'google/gemini-3.1-flash-lite',
    editorModel: env.ALDUS_EDITOR_MODEL || 'claude-sonnet-5',
    maxTurns: Number(env.ALDUS_MAX_TURNS || 24),
    openrouter: {
      key: env.OPENROUTER_API_KEY || '',
      baseUrl: (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    },
  };
}
