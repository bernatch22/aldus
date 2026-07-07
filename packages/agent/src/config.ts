/**
 * config.ts — every environment knob of the agent, documented in ONE place.
 *
 * | Variable                 | Default                     | Meaning                                   |
 * |--------------------------|-----------------------------|-------------------------------------------|
 * | ALDUS_PROVIDER           | subscription                | 'subscription' (Claude Agent SDK) or      |
 * |                          |                             | 'openrouter' (OpenAI-compatible endpoint).|
 * | ALDUS_MODEL              | claude-sonnet-5             | Modelo EDITOR (aplica cambios) — subscription. |
 * | ALDUS_CHAT_MODEL         | claude-haiku-4-5            | Modelo CHAT/router (describe, delega) — subscription. |
 * | ALDUS_MAX_TURNS          | 24                          | Max agent turns per request.              |
 * | ANTHROPIC_API_KEY        | (unset)                     | Leave UNSET to bill the Claude Code sub.  |
 * | OPENROUTER_API_KEY       | (unset)                     | Bearer for the OpenRouter path (o un      |
 * |                          |                             | token de sesión del llm-proxy `sess_…`).  |
 * | OPENROUTER_BASE_URL      | https://openrouter.ai/api/v1| Base OpenAI-compatible (apuntá al llm-proxy|
 * |                          |                             | para el demo público).                    |
 * | ALDUS_OPENROUTER_MODEL   | anthropic/claude-sonnet-5   | Modelo EDITOR — OpenRouter.               |
 * | ALDUS_OPENROUTER_CHAT_MODEL | qwen/qwen3-next-80b-a3b-instruct | Modelo CHAT/router — OpenRouter.   |
 *
 * Arquitectura en DOS NIVELES: el modelo CHAT (barato) atiende la conversación y
 * describe el contenido; SOLO cuando hay que modificar el PDF llama la tool
 * edit_document({pages, request}) → el modelo EDITOR corre con los grafos de
 * ESAS páginas inyectados y las tools reales. Sonnet no se gasta en charla.
 */
const provider = (process.env.ALDUS_PROVIDER === 'openrouter' ? 'openrouter' : 'subscription') as 'subscription' | 'openrouter';

export const config = {
  provider,
  model: process.env.ALDUS_MODEL || 'claude-sonnet-5',
  chatModel: process.env.ALDUS_CHAT_MODEL || 'claude-haiku-4-5',
  maxTurns: Number(process.env.ALDUS_MAX_TURNS || 24),
  openrouter: {
    key: process.env.OPENROUTER_API_KEY || '',
    baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    model: process.env.ALDUS_OPENROUTER_MODEL || 'anthropic/claude-sonnet-5',
    chatModel: process.env.ALDUS_OPENROUTER_CHAT_MODEL || 'qwen/qwen3-next-80b-a3b-instruct',
  },
} as const;
