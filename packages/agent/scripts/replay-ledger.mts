/**
 * replay-ledger.mts — re-ejecuta SIN LLM las tool calls de una corrida anterior
 * del harness (el `toolCalls` de su summary.json trae los args exactos que pasó
 * el modelo) y hornea output.pdf. Para iterar sobre placeholders_to_fields en
 * forma determinística y gratis; después `eval-placeholders.mts --reuse` hace
 * el render + crops sin tocar el LLM.
 *
 *   npx tsx scripts/replay-ledger.mts <dir-del-doc-en-el-eval>   (usa original.pdf + summary.json)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDoc } from '../src/graph.js';
import { EditSession } from '../src/session/EditSession.js';
import { createAgentContainer } from '../src/ioc.js';
import { IToolRegistry } from '../src/tools/registry.js';

const dir = process.argv[2];
if (!dir) { console.error('uso: npx tsx scripts/replay-ledger.mts <dir con original.pdf + summary.json>'); process.exit(1); }

const summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')) as
  { toolCalls: Array<{ tool: string; args: Record<string, unknown> }> };
const container = createAgentContainer();
const registry = container.get(IToolRegistry);
const tools = new Map([...registry.forLevel('reader'), ...registry.forLevel('editor')].map(t => [t.name, t] as const));

const doc = await loadDoc(path.join(dir, 'original.pdf'));
const session = new EditSession(doc);
const ctx = { doc, session, emit: (): void => {} };

for (const c of summary.toolCalls) {
  const tool = tools.get(c.tool);
  if (!tool) { console.log(`   · ${c.tool}: (tool desconocida, salteada)`); continue; }
  const result = String(await tool.run(ctx, c.args));
  console.log(`   · ${c.tool} → ${result.replace(/\n/g, ' ⏎ ').slice(0, 220)}`);
}
const { applied, warnings } = await session.save(path.join(dir, 'output.pdf'));
console.log(`✓ output.pdf — ${applied.length} aplicada(s)`);
for (const w of warnings) console.log(`   ⚠️ ${w}`);
