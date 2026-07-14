/**
 * config.ts — every environment knob of the agent, documented in ONE place.
 *
 * v2: los knobs viven en la interfaz {@link IAgentConfig} (INYECTABLE — los tests
 * del orquestador pasan la suya, sin depender del entorno). `loadAgentConfig()`
 * lee el entorno UNA vez y devuelve la data plana (igual que el `config` const de
 * v1); `defaultAgentConfig` es el singleton listo para los hosts.
 *
 * DOS proveedores de LLM, misma arquitectura de DOS NIVELES (chat barato que
 * describe/delega → editor fuerte que aplica con las tools reales):
 *   - 'subscription' (default): Claude Agent SDK sobre la SUSCRIPCIÓN de Claude
 *     Code (corré SIN ANTHROPIC_API_KEY). Haiku router + Sonnet editor.
 *   - 'openrouter': endpoint OpenAI-compatible (OpenRouter, o el llm-proxy del
 *     .dev). Para el demo público (la suscripción no se puede exponer en server)
 *     y para PROBAR modelos alternativos (DeepSeek, Gemini Flash, etc.).
 *
 * | Variable                    | Default                        | Meaning                                  |
 * |-----------------------------|--------------------------------|------------------------------------------|
 * | ALDUS_PROVIDER              | subscription                   | 'subscription' | 'openrouter'.           |
 * | ALDUS_MODEL                 | claude-sonnet-5                | Editor — subscription.                   |
 * | ALDUS_CHAT_MODEL            | claude-haiku-4-5               | Chat/router — subscription.              |
 * | ALDUS_MAX_TURNS             | 24                             | Max turnos del editor por request.       |
 * | ANTHROPIC_API_KEY           | (unset)                        | Dejar SIN setear para facturar la sub.   |
 * | CLAUDE_CODE_OAUTH_TOKEN     | (unset)                        | Token de `claude setup-token` (headless).|
 * | OPENROUTER_API_KEY          | (unset)                        | Bearer de OpenRouter (o token del proxy).|
 * | OPENROUTER_BASE_URL         | https://openrouter.ai/api/v1   | Base OpenAI-compatible.                  |
 * | ALDUS_OPENROUTER_MODEL      | google/gemini-3.5-flash        | Editor — OpenRouter (tool-calling fino). |
 * | ALDUS_OPENROUTER_CHAT_MODEL | google/gemini-3.1-flash-lite   | Chat/router — OpenRouter (barato+rápido).|
 */

export type AgentProvider = 'subscription' | 'openrouter';

export interface IAgentOpenRouterConfig {
  key: string;
  baseUrl: string;
  model: string;
  chatModel: string;
}

export interface IAgentConfig {
  provider: AgentProvider;
  model: string;
  chatModel: string;
  maxTurns: number;
  openrouter: IAgentOpenRouterConfig;
}

/** Lee TODOS los knobs del entorno una vez y arma la data plana. */
export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): IAgentConfig {
  const provider: AgentProvider = env.ALDUS_PROVIDER === 'openrouter' ? 'openrouter' : 'subscription';
  return {
    provider,
    model: env.ALDUS_MODEL || 'claude-sonnet-5',
    chatModel: env.ALDUS_CHAT_MODEL || 'claude-haiku-4-5',
    maxTurns: Number(env.ALDUS_MAX_TURNS || 24),
    openrouter: {
      key: env.OPENROUTER_API_KEY || '',
      baseUrl: (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
      // Combo recomendado (mejor calidad/costo, medido): el CHAT ve TODO el doc
      // (input grande) → conviene el BARATO (flash-lite, $0.25/M in); el EDITOR
      // hace el tool-calling fino → el bueno (3.5-flash). ~1.8¢/turno en un doc de
      // 9 págs — la mitad que todo-3.5-flash, misma calidad y MÁS rápido (el
      // chat-lite rutea en ~1.3s). Todo-lite es ~0.6¢ pero el editor se ensucia
      // (mete tools de más, llena menos campos).
      model: env.ALDUS_OPENROUTER_MODEL || 'google/gemini-3.5-flash',
      chatModel: env.ALDUS_OPENROUTER_CHAT_MODEL || 'google/gemini-3.1-flash-lite',
    },
  };
}

/** Singleton listo para los hosts (server/CLI). Los tests inyectan el suyo. */
export const defaultAgentConfig: IAgentConfig = loadAgentConfig();
