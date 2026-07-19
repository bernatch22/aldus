/** dbg-rows.mts — replay del ledger + dump de FILAS (runs x/width/gaps) y
 *  widgets de una página, para diagnosticar geometría del reflow sin UI.
 *    npx tsx scripts/dbg-rows.mts <dir-eval> <página> [filtro-texto]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDoc, graphFromBytes } from '../src/graph.js';
import { EditSession } from '../src/session/EditSession.js';
import { createAgentContainer } from '../src/ioc.js';
import { IToolRegistry } from '../src/tools/registry.js';

const [dir, pageArg, filter] = process.argv.slice(2);
const pageNum = Number(pageArg || 1);

const summary = JSON.parse(await readFile(path.join(dir!, 'summary.json'), 'utf8')) as
  { toolCalls: Array<{ tool: string; args: Record<string, unknown> }> };
const container = createAgentContainer();
const registry = container.get(IToolRegistry);
const tools = new Map([...registry.forLevel('reader'), ...registry.forLevel('editor')].map(t => [t.name, t] as const));

const doc = await loadDoc(path.join(dir!, 'original.pdf'));
const session = new EditSession(doc);
const ctx = { doc, session, emit: (): void => {} };
for (const c of summary.toolCalls) {
  const tool = tools.get(c.tool);
  if (tool) await tool.run(ctx, c.args);
}
const { pdf } = await session.bake();
const re = await graphFromBytes(pdf.slice());
const page = re.pages.find(p => p.page === pageNum)!;

const r = (n: number): number => Math.round(n * 10) / 10;
const rows = [...page.segments].sort((a, b) => b.baseline - a.baseline || a.x - b.x);
for (const s of rows) {
  if (filter && !s.text.includes(filter)) continue;
  console.log(`SEG ${s.id} @(${r(s.x)},${r(s.baseline)}) w=${r(s.width)} ${r(s.fontSize)}pt: ${JSON.stringify(s.text.slice(0, 90))}`);
  let prevEnd: number | null = null;
  for (const run of s.runs) {
    const gap = prevEnd != null ? r(run.x - prevEnd) : null;
    console.log(`   run @(${r(run.x)},${r(run.baseline)}) w=${r(run.width)}${gap != null ? ` gap=${gap}` : ''}: ${JSON.stringify(run.text.slice(0, 50))}`);
    prevEnd = run.x + run.width;
  }
}
console.log('--- WIDGETS ---');
for (const w of page.widgets) console.log(`  ${w.fieldName} @(${r(w.x)},${r(w.y)}) ${r(w.width)}×${r(w.height)}`);
