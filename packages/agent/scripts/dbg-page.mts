/** dbg-page.mts — ¿el MOTOR puede con los placeholders de una página? Busca los
 *  párrafos con leaders/rellenos y corre placeholders_to_fields en cada uno, sin
 *  LLM. Separa "el motor no puede" de "el LLM no lo pidió".
 *    npx tsx scripts/dbg-page.mts <pdf> <página>
 */
import { loadDoc } from '../src/graph.js';
import { EditSession } from '../src/session/EditSession.js';

const [pdf, pageArg] = process.argv.slice(2);
const pageNum = Number(pageArg || 1);
const doc = await loadDoc(pdf!);
const page = doc.pages.find(p => p.page === pageNum)!;

const PLACEHOLDER = /[.…_]{4,}|(?<![\p{L}\p{N}])(?:[xX]{3,}|\*{3,})(?![\p{L}\p{N}])/u;
const hits = page.segments.filter(s => PLACEHOLDER.test(s.text));
console.log(`p${pageNum}: ${page.segments.length} segmentos · ${hits.length} con placeholders\n`);

const session = new EditSession(doc);
for (const s of hits) {
  const m = PLACEHOLDER.exec(s.text)!;
  console.log(`${s.id} @(${Math.round(s.x)},${Math.round(s.baseline)}): ${JSON.stringify(s.text.slice(0, 80))}`);
  const msg = await session.placeholdersToFields(s.id, [{ placeholder: m[0], name: `campo_p${pageNum}` }]);
  console.log(`   → ${msg.replace(/\n/g, ' ').slice(0, 200)}\n`);
}
