/** dbg-prompt.mts — imprime el GRAFO SERIALIZADO tal cual lo ve el editor de una
 *  página (lo que va en su system prompt). Para diagnosticar por qué un editor
 *  "no hace nada": si el texto llega ilegible/corrupto, el modelo no se anima.
 *    npx tsx scripts/dbg-prompt.mts <pdf> <página>
 */
import { loadDoc } from '../src/graph.js';
import { serializeDoc } from '../src/serialize.js';

const [pdf, pageArg] = process.argv.slice(2);
const doc = await loadDoc(pdf!);
console.log(serializeDoc(doc, [Number(pageArg || 1)]));
