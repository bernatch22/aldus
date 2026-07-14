/**
 * reproTemplate.ts — el script `repro.mts` del MODO FORENSE 🐞, como módulo
 * propio (audit-hosts §2: en v1 eran 104 de las 129 líneas de routes/debug.ts —
 * payload de tooling embebido en un router). La ruta queda en ~25 líneas.
 *
 * El script generado importa del SOURCE del repo (`REPO`) → editás core/bake,
 * volvés a correr, ves el efecto. Loop de fix ultra corto sin tocar la UI.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// repo root = apps/server/src → 3 niveles arriba. En el bundle del demo esto
// no aplica (la ruta está gateada por ALDUS_DEBUG, que prod no setea).
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const reproTemplate = (repo: string): string => `/**
 * Aldus forensic repro — auto-generado por el modo 🐞 del editor.
 * Correr:   npx tsx ${'${'}import.meta.url${'}'}  →  npx tsx <este archivo>
 * Edita ${repo}/packages/core (bake/extract) y volvé a correr para probar fixes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphFromBytes } from '${repo}/packages/agent/src/graph.ts';
import { bakeSegmentEdits } from '${repo}/packages/core/src/bake/index.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const cap = JSON.parse(readFileSync(path.join(dir, 'capture.json'), 'utf8'));
const bytes = new Uint8Array(readFileSync(path.join(dir, 'doc.pdf')));

const r = (n: number) => Math.round(n * 10) / 10;

/** Vuelca la FILA del nodo (misma baseline ±3pt): x/ancho/texto por segmento,
 *  runs con sus gaps — acá se ve una pérdida de espacio o un corrimiento. */
function dumpRow(tag: string, page: any, nodeId: string | null, clickNode?: any) {
  console.log('\\n══ ' + tag + ' ══');
  if (!page) return console.log('  (página no encontrada)');
  const target = nodeId ? page.segments.find((s: any) => s.id === nodeId) : null;
  const base = target?.baseline ?? clickNode?.baseline;
  const row = base != null
    ? page.segments.filter((s: any) => Math.abs(s.baseline - base) < 3).sort((a: any, b: any) => a.x - b.x)
    : page.segments.slice(0, 8);
  if (!row.length) return console.log('  (fila vacía — ¿nodo borrado/reemplazado? probá por texto)');
  for (const s of row) {
    const mark = s.id === nodeId ? ' ◀◀◀ TARGET' : '';
    console.log(\`  \${s.id} @(\${r(s.x)},\${r(s.baseline)}) w=\${r(s.width)} \${r(s.fontSize)}pt: \${JSON.stringify(s.text)}\${mark}\`);
    if (s.runs?.length > 1) {
      let prevEnd: number | null = null;
      for (const run of s.runs) {
        const gap = prevEnd != null ? r(run.x - prevEnd) : null;
        const gapTag = gap != null ? (gap < 0 ? \` GAP=\${gap} ⚠️SOLAPE\` : \` gap=\${gap}\`) : '';
        console.log(\`      run @\${r(run.x)} w=\${r(run.width)}\${run.font?.bold ? ' bold' : ''}\${run.font?.italic ? ' italic' : ''}\${gapTag}: \${JSON.stringify(run.text)}\`);
        prevEnd = run.x + run.width;
      }
    }
  }
  // gaps ENTRE segmentos de la fila (columna / lista "a)" — acá se pierden)
  for (let i = 1; i < row.length; i++) {
    const gap = r(row[i].x - (row[i - 1].x + row[i - 1].width));
    console.log(\`  · gap entre \${row[i - 1].id} y \${row[i].id}: \${gap}pt\${gap < 0 ? ' ⚠️SOLAPE' : ''}\`);
  }
}

// ── 1. Grafo AL MOMENTO DEL CLICK (lo que la UI veía) ──
if (cap.clickPage) dumpRow('AL CLICK (grafo que veía la UI)', cap.clickPage, cap.nodeId);

// ── 2. Grafo FRESCO (extraído ahora de doc.pdf, PRE-bake) ──
const before = await graphFromBytes(bytes.slice());
const pageB = before.pages.find((p: any) => p.page === cap.page);
dumpRow('FRESCO (re-extraído ahora, pre-bake)', pageB, cap.nodeId);

// ── 3. Aplicar los edits pendientes con el BAKE REAL y re-extraer ──
const nEdits = (cap.edits?.length ?? 0) + (cap.imageEdits?.length ?? 0) + (cap.widgetEdits?.length ?? 0)
  + (cap.highlightEdits?.length ?? 0) + (cap.linkEdits?.length ?? 0);
if (nEdits) {
  const { pdf, applied, warnings } = await bakeSegmentEdits(
    bytes.slice(), cap.edits ?? [], cap.imageEdits ?? [], cap.widgetEdits ?? [],
    cap.highlightEdits ?? [], cap.linkEdits ?? [],
  );
  writeFileSync(path.join(dir, 'out.pdf'), pdf);
  console.log(\`\\n── bake: \${applied.length} aplicadas, \${warnings.length} warnings → out.pdf ──\`);
  for (const w of warnings) console.log('  ⚠️ ' + w);
  const after = await graphFromBytes(pdf.slice());
  const pageA = after.pages.find((p: any) => p.page === cap.page);
  dumpRow('DESPUÉS DEL BAKE (out.pdf re-extraído)', pageA, cap.nodeId);
} else {
  console.log('\\n(no había edits pendientes — solo comparación click vs fresco)');
}
if (cap.pendingHighlights?.length) console.log(\`\\n(nota: \${cap.pendingHighlights.length} highlight(s) NUEVOS pendientes — van por createNodes, no por este bake)\`);
console.log('\\nnodo target:', cap.nodeId, '· página', cap.page, '· capturado', cap.capturedAt);
console.log('trace de la sesión y estado completo en: ' + path.join(dir, 'capture.json'));
`;
