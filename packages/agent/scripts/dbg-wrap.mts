/** dbg-wrap.mts — números internos del wrap para un párrafo+placeholders del
 *  ledger: capacity/spaceW/leading, suma de tokens, filas por escala, slack.
 *    npx tsx scripts/dbg-wrap.mts <dir-eval> <segId>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { paragraphOf, paragraphToks, matchPlaceholders, type LayoutEnv, type ReflowTok } from '@aldus/core';
import { loadDoc } from '../src/graph.js';

const [dir, segId] = process.argv.slice(2);
const summary = JSON.parse(await readFile(path.join(dir!, 'summary.json'), 'utf8')) as
  { toolCalls: Array<{ tool: string; args: Record<string, unknown> }> };
let fields: Array<{ placeholder: string; name: string }> | undefined;
for (const c of summary.toolCalls) {
  if (c.tool === 'placeholders_to_fields' && c.args.id === segId) fields = c.args.fields as typeof fields;
  if (c.tool === 'placeholders_to_fields_batch') {
    for (const g of c.args.groups as Array<{ id: string; fields: typeof fields }>) if (g.id === segId) fields = g.fields;
  }
}
const doc = await loadDoc(path.join(dir!, 'original.pdf'));
const ENV: LayoutEnv = { effBaseline: s => s.baseline, isRemoved: () => false };
const page = doc.pages.find(p => p.segments.some(s => s.id === segId))!;
const s = page.segments.find(x => x.id === segId)!;
const para = paragraphOf(page, s, ENV);
console.log(`para: ${para.lines.length} líneas · capacity=${Math.round(para.capacity)} · spaceW=${Math.round(para.spaceW * 100) / 100} · leading=${Math.round(para.leading * 10) / 10} · rightEdge=${Math.round(para.rightEdge)}`);
for (const l of para.lines) console.log(`  line @(${Math.round(l.x)},${Math.round(l.baseline)}) w=${Math.round(l.width)}: ${JSON.stringify(l.text.slice(0, 70))}`);

const res = matchPlaceholders(para.lines, fields!, { page: s.page, fontSize: s.fontSize, existingWidgets: [], queuedFields: [] });
console.log(`match: needsReflow=${res.needsReflow} holes=${res.holes?.length} (${res.holes?.filter(h => !h.drop && h.name).map(h => `${h.name}:${Math.round(h.target)}`).join(', ')})`);

const toks = paragraphToks(para, res.holes ?? []);
const wsum = toks.filter(t => t.kind === 'word').reduce((n, t) => n + t.w, 0);
console.log(`toks: ${toks.length} (${toks.filter(t => t.kind === 'hole').length} holes) · Σwords=${Math.round(wsum)}`);

// réplica del wrap de reflowApply
const holeW = (t: ReflowTok, scale: number): number => Math.max(25, t.hole!.target * scale);
const wrap = (scale: number, capShrink: number): number => {
  const cap = para.capacity - capShrink;
  let rows = 1, curW = 0, len = 0;
  for (const t of toks) {
    const w = t.kind === 'hole' ? holeW(t, scale) : t.w;
    const sep = len ? para.spaceW : 0;
    if (curW + sep + w > cap && len) {
      const avail = cap - curW - sep;
      if (t.kind === 'hole' && avail >= 40) { curW += sep + avail; len++; continue; }
      rows++; curW = 0; len = 0;
    }
    curW += (len ? para.spaceW : 0) + w;
    len++;
  }
  return rows;
};
for (const sc of [1, 0.9, 0.7, 0.5, 0.3]) console.log(`  scale=${sc} → ${wrap(sc, 0)} filas`);

// slack para crecer (réplica de reflowApply)
const MARGIN_FLOOR = 58;
const pageBottomEff = Math.min(para.paraBottom, ...page.segments.filter(o => o.baseline >= MARGIN_FLOOR).map(o => o.baseline));
console.log(`paraBottom=${Math.round(para.paraBottom)} · pageBottomEff=${Math.round(pageBottomEff)} · slack=${Math.round(Math.max(0, pageBottomEff - MARGIN_FLOOR))} · maxExtra=${Math.min(3, Math.floor(Math.max(0, pageBottomEff - MARGIN_FLOOR) / para.leading))}`);
