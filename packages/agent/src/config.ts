/**
 * config.ts — every environment knob of the agent, documented in ONE place.
 *
 * | Variable                 | Default                     | Meaning                                   |
 * |--------------------------|-----------------------------|-------------------------------------------|
 * | ALDUS_PROVIDER           | subscription                | 'subscription' (Claude Agent SDK) or      |
 * |                          |                             | 'openrouter' (OpenAI-compatible endpoint).|
 * | ALDUS_MODEL              | claude-sonnet-5             | Model id — subscription path.             |
 * | ALDUS_MAX_TURNS          | 24                          | Max agent turns per request.              |
 * | ANTHROPIC_API_KEY        | (unset)                     | Leave UNSET to bill the Claude Code sub.  |
 * | OPENROUTER_API_KEY       | (unset)                     | Bearer for the OpenRouter path (o un      |
 * |                          |                             | token de sesión del llm-proxy `sess_…`).  |
 * | OPENROUTER_BASE_URL      | https://openrouter.ai/api/v1| Base OpenAI-compatible (apuntá al llm-proxy|
 * |                          |                             | para el demo público).                    |
 * | ALDUS_OPENROUTER_MODEL   | anthropic/claude-3.5-sonnet | Model id — OpenRouter path.               |
 */
const provider = (process.env.ALDUS_PROVIDER === 'openrouter' ? 'openrouter' : 'subscription') as 'subscription' | 'openrouter';

export const config = {
  provider,
  model: process.env.ALDUS_MODEL || 'claude-sonnet-5',
  maxTurns: Number(process.env.ALDUS_MAX_TURNS || 24),
  openrouter: {
    key: process.env.OPENROUTER_API_KEY || '',
    baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    model: process.env.ALDUS_OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
  },
} as const;
