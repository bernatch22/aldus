/** dbg-emit.mts — corre UNA llamada placeholders_to_fields (args del ledger) y
 *  muestra los STYLED RUNS EMITIDOS (texto+dx) del segmento, el layout final y
 *  los campos — el estado interno del reflow, sin adivinar desde el render.
 *    npx tsx scripts/dbg-emit.mts <dir-eval> <segId>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDoc } from '../src/graph.js';
import { EditSession } from '../src/session/EditSession.js';

const [dir, segId] = process.argv.slice(2);
const summary = JSON.parse(await readFile(path.join(dir!, 'summary.json'), 'utf8')) as
  { toolCalls: Array<{ tool: string; args: Record<string, unknown> }> };

// Buscar el grupo del batch (o la llamada suelta) que apunta a segId.
let fields: Array<{ placeholder: string; name: string }> | undefined;
for (const c of summary.toolCalls) {
  if (c.tool === 'placeholders_to_fields' && c.args.id === segId) fields = c.args.fields as typeof fields;
  if (c.tool === 'placeholders_to_fields_batch') {
    for (const g of c.args.groups as Array<{ id: string; fields: typeof fields }>) {
      if (g.id === segId) fields = g.fields;
    }
  }
}
if (!fields) { console.error(`no hay llamada para ${segId} en el ledger`); process.exit(1); }
console.log('ARGS fields:', JSON.stringify(fields));

const doc = await loadDoc(path.join(dir!, 'original.pdf'));
const session = new EditSession(doc);
const msg = await session.placeholdersToFields(segId!, fields);
console.log('\nRESULT:', msg, '\n');

const { edits } = session.getEdits();
for (const e of edits) {
  if (!e.runs) continue;
  console.log(`EDIT ${e.segmentId}${e.baseline !== undefined ? ` bl→${Math.round(e.baseline)}` : ''}:`);
  for (const r of e.runs) console.log(`   dx=${Math.round((r.dx ?? 0) * 10) / 10}${r.bold ? ' B' : ''}${r.italic ? ' I' : ''}: ${JSON.stringify(r.text)}`);
}
