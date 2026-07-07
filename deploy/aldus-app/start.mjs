/**
 * start.mjs — entry del servicio. Carga ~/.env box-local (OPENROUTER_API_KEY)
 * ANTES de importar el bundle (config del agente lee el env al cargar), fija el
 * provider a OpenRouter y arranca el server real (dist/app.mjs).
 */
import 'dotenv/config';

process.env.ALDUS_PROVIDER ||= 'openrouter';
process.env.ALDUS_OPENROUTER_MODEL ||= 'qwen/qwen3-coder';
process.env.ALDUS_STATIC ||= new URL('./dist/public', import.meta.url).pathname;
delete process.env.ANTHROPIC_API_KEY;

await import('./dist/app.mjs');
