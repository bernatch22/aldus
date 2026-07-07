/**
 * config.ts — every environment knob of the agent, documented in ONE place.
 *
 * | Variable            | Default            | Meaning                                        |
 * |---------------------|--------------------|------------------------------------------------|
 * | ALDUS_MODEL         | claude-sonnet-5    | Model id passed to the Claude Agent SDK.       |
 * | ALDUS_MAX_TURNS     | 24                 | Max agent turns per request.                   |
 * | ANTHROPIC_API_KEY   | (unset)            | Leave UNSET to bill the Claude Code            |
 * |                     |                    | subscription instead of the API.               |
 */
export const config = {
  model: process.env.ALDUS_MODEL || 'claude-sonnet-5',
  maxTurns: Number(process.env.ALDUS_MAX_TURNS || 24),
} as const;
