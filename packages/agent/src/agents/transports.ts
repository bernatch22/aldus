/**
 * transports.ts — elegir el pipe por el ID DEL MODELO (config.ts): `vendor/slug`
 * → OpenRouter, cualquier otro (`claude-*`) → Claude Agent SDK. No hay knob de
 * provider: el modelo YA dice por dónde va. Así el reader puede correr en Gemini
 * y el editor en Sonnet en el MISMO turno, sin ninguna rama en los agentes.
 */
import type { IAgentConfig } from '../config.js';
import { isOpenRouterModel } from '../config.js';
import type { ILlmTransport } from '../transport/transport.js';
import { ClaudeSdkTransport } from '../transport/claudeSdk.js';
import { OpenRouterTransport } from '../transport/openRouter.js';

export function transportFor(model: string, config: IAgentConfig): ILlmTransport {
  if (!isOpenRouterModel(model)) return new ClaudeSdkTransport();
  if (!config.openrouter.key) {
    throw new Error(`El modelo "${model}" va por OpenRouter pero falta OPENROUTER_API_KEY.`);
  }
  return new OpenRouterTransport(config.openrouter);
}
