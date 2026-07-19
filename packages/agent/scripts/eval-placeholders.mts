/**
 * eval-placeholders.mts — harness E2E de placeholders→campos: agarra PDFs
 * ORIGINALES, los pasa por el flujo REAL de dos agentes (READER rutea →
 * EDITOR aplica con las tools), hornea el PDF de salida, y recorta imágenes
 * BEFORE/AFTER de la zona de CADA campo creado (el rect sale del grafo
 * re-extraído del output — sabemos exactamente dónde quedó cada input).
 *
 *   cd packages/agent
 *   npx tsx scripts/eval-placeholders.mts <pdf...> [opciones]
 *
 *   --out <dir>     directorio de salida            (default /tmp/aldus-eval-v2)
 *   --prompt "..."  instrucción al agente           (default: convertir TODOS los placeholders)
 *   --dpi <n>       resolución del render           (default 150)
 *   --reuse         si ya existe <doc>/output.pdf NO llama al LLM (solo re-renderiza
 *                   y re-recorta — para iterar barato sobre el render/crops)
 *
 * Por documento deja:  original.pdf · output.pdf · page-N.{orig,out}.png ·
 * fields/NN-<nombre>.png (montaje original|editado con el rect del campo en rojo) ·
 * summary.json (ledger de tools con args+resultado, applied, warnings, rects) ·
 * index.html (galería).
 *
 * Necesita `pdftoppm` (poppler) y `magick` (ImageMagick) en el PATH.
 * Modelos: ALDUS_READER_MODEL / ALDUS_EDITOR_MODEL (default Gemini vía
 * OpenRouter → necesita OPENROUTER_API_KEY).
 */
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { loadDoc, graphFromBytes, type DocGraph } from '../src/graph.js';
import { EditSession } from '../src/session/EditSession.js';
import { createAgentContainer } from '../src/ioc.js';
import { IAgentConfig } from '../src/config.js';
import { IToolRegistry } from '../src/tools/registry.js';
import { readTurn } from '../src/agents/reader.js';
import { editPages } from '../src/agents/editor.js';

const exec = promisify(execFile);

const DEFAULT_PROMPT =
  'Convertí TODOS los placeholders del documento en campos de formulario rellenables: ' +
  'líneas de puntos (.....), guiones bajos (____), y también los rellenos tipo XXXX / xxx / ***. ' +
  'Poné nombres descriptivos a cada campo. No cambies ningún otro contenido.';

interface FieldCrop { name: string; page: number; x: number; y: number; width: number; height: number; img: string }

/** Ledger de tool calls con args + RESULTADO: se envuelve el run de CADA tool
 *  del registry (los eventos del wire solo traen el nombre). */
const toolLedger: Array<{ tool: string; args: unknown; result: string }> = [];

/** Renderiza un PDF a PNGs por página; devuelve {page → ruta}. */
async function renderPdf(pdf: string, dir: string, prefix: string, dpi: number): Promise<Map<number, string>> {
  await exec('pdftoppm', ['-png', '-r', String(dpi), pdf, path.join(dir, prefix)]);
  const out = new Map<number, string>();
  for (const f of await readdir(dir)) {
    const m = f.match(new RegExp(`^${prefix}-0*(\\d+)\\.png$`));
    if (m) out.set(Number(m[1]), path.join(dir, f));
  }
  return out;
}

async function imgSize(img: string): Promise<{ w: number; h: number }> {
  const { stdout } = await exec('magick', ['identify', '-format', '%w %h', img]);
  const [w, h] = stdout.trim().split(' ').map(Number);
  return { w: w!, h: h! };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      prompt: { type: 'string' },
      dpi: { type: 'string' },
      reuse: { type: 'boolean' },
    },
  });
  if (!positionals.length) {
    console.error('uso: npx tsx scripts/eval-placeholders.mts <pdf...> [--out dir] [--prompt "..."] [--dpi 150] [--reuse]');
    process.exit(1);
  }
  const outRoot = values.out || '/tmp/aldus-eval-v2';
  const dpi = Number(values.dpi || 150);
  const prompt = values.prompt || DEFAULT_PROMPT;
  const scale = dpi / 72;
  const PAD = 45; // pt de contexto alrededor del campo en cada crop

  const container = createAgentContainer();
  const config = container.get(IAgentConfig);
  const registry = container.get(IToolRegistry);
  // Envolver TODAS las tools (reader+editor) para el ledger.
  const seen = new Set<string>();
  for (const t of [...registry.forLevel('reader'), ...registry.forLevel('editor')]) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    const orig = t.run.bind(t);
    t.run = async (ctx, args) => {
      const result = String(await orig(ctx, args));
      toolLedger.push({ tool: t.name, args, result });
      console.log(`   · ${t.name} → ${result.replace(/\n/g, ' ⏎ ').slice(0, 220)}`);
      return result;
    };
  }

  const docsIndex: string[] = [];
  for (const src of positionals) {
    const slug = path.basename(src, path.extname(src)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const dir = path.join(outRoot, slug);
    const fieldsDir = path.join(dir, 'fields');
    // limpiar crops de una corrida anterior (si cambió el nº de campos, quedaban mezclados)
    await exec('rm', ['-rf', fieldsDir]);
    await mkdir(fieldsDir, { recursive: true });
    const origPdf = path.join(dir, 'original.pdf');
    const outPdf = path.join(dir, 'output.pdf');
    await copyFile(src, origPdf);
    console.log(`\n━━ ${slug}  (reader=${config.readerModel} · editor=${config.editorModel})`);

    // ── 1. Flujo REAL de dos agentes: reader → editPages → output.pdf ──
    let answer = '';
    toolLedger.length = 0;
    if (values.reuse && existsSync(outPdf)) {
      console.log('   (reuse: salteo el LLM, uso output.pdf existente)');
    } else {
      const doc: DocGraph = await loadDoc(origPdf);
      const session = new EditSession(doc);
      const t0 = Date.now();
      await readTurn({
        doc, session, prompt,
        onEvent: ev => { if (ev.type === 'text' && ev.agent !== 'editor') answer += ev.delta; },
        editor: async route => {
          const r = await editPages({ doc, session, request: route.request, pages: route.pages, parallel: route.parallel }, registry, config);
          return r.text || `✓ editor corrió ${r.toolCalls} tool/s.`;
        },
      }, registry, config);
      console.log(`   LLM listo en ${Math.round((Date.now() - t0) / 1000)}s — ${session.count} edición(es)`);
      if (session.count === 0) {
        console.log('   ⚠️ el agente no hizo NINGUNA edición');
        await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ prompt, answer, toolCalls: toolLedger, applied: [], warnings: ['sin ediciones'] }, null, 2));
        continue;
      }
      const { applied, warnings } = await session.save(outPdf);
      await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ prompt, answer, toolCalls: toolLedger, applied, warnings }, null, 2));
      for (const w of warnings) console.log(`   ⚠️ ${w}`);
    }

    // ── 2. Campos NUEVOS del output (diff de widgets contra el original) ──
    const [origGraph, outGraph] = await Promise.all([
      graphFromBytes(new Uint8Array(await readFile(origPdf))),
      graphFromBytes(new Uint8Array(await readFile(outPdf))),
    ]);
    const had = new Set(origGraph.pages.flatMap(p => p.widgets.map(w => `${w.page}:${w.fieldName}`)));
    const newWidgets = outGraph.pages.flatMap(p => p.widgets.filter(w => !had.has(`${w.page}:${w.fieldName}`)));
    console.log(`   ${newWidgets.length} campo(s) nuevo(s) en el output`);

    // ── 3. Render + crops before/after con el rect del campo marcado en rojo ──
    const [origPages, outPages] = await Promise.all([
      renderPdf(origPdf, dir, 'page-orig', dpi),
      renderPdf(outPdf, dir, 'page-out', dpi),
    ]);
    const pageH = new Map(outGraph.pages.map(p => [p.page, p.height] as const));
    const crops: FieldCrop[] = [];
    let i = 0;
    for (const w of newWidgets) {
      i++;
      const H = pageH.get(w.page) ?? 792;
      const imgO = origPages.get(w.page), imgE = outPages.get(w.page);
      if (!imgO || !imgE) continue;
      const { w: pxW, h: pxH } = await imgSize(imgE);
      const cx = Math.max(0, Math.round((w.x - PAD) * scale));
      const cy = Math.max(0, Math.round((H - w.y - w.height - PAD) * scale));
      const cw = Math.min(pxW - cx, Math.round((w.width + 2 * PAD) * scale));
      const ch = Math.min(pxH - cy, Math.round((w.height + 2 * PAD) * scale));
      const rx0 = Math.round(w.x * scale) - cx, ry0 = Math.round((H - w.y - w.height) * scale) - cy;
      const rx1 = rx0 + Math.round(w.width * scale), ry1 = ry0 + Math.round(w.height * scale);
      const crop = `${cw}x${ch}+${cx}+${cy}`;
      const a = path.join(fieldsDir, `_a.png`), b = path.join(fieldsDir, `_b.png`);
      await exec('magick', [imgO, '-crop', crop, '+repage', a]);
      await exec('magick', [imgE, '-crop', crop, '+repage', '-stroke', 'red', '-strokewidth', '2', '-fill', 'none',
        '-draw', `rectangle ${rx0},${ry0} ${rx1},${ry1}`, b]);
      const name = (w.fieldName || `campo${i}`).replace(/[^\w-]+/g, '_');
      const img = path.join(fieldsDir, `${String(i).padStart(2, '0')}-p${w.page}-${name}.png`);
      await exec('magick', ['montage', '-label', 'ORIGINAL', a, '-label', 'EDITADO', b,
        '-tile', '2x1', '-geometry', '+8+8', '-background', 'white', img]);
      crops.push({ name: w.fieldName, page: w.page, x: w.x, y: w.y, width: w.width, height: w.height, img: path.relative(dir, img) });
    }
    await exec('rm', ['-f', path.join(fieldsDir, '_a.png'), path.join(fieldsDir, '_b.png')]);

    // ── 4. Galería HTML del documento ──
    const html = `<!doctype html><meta charset="utf-8"><title>${slug}</title>
<style>body{font:14px system-ui;margin:24px;background:#f5f5f5}img{max-width:100%;border:1px solid #ccc;background:#fff}h2{margin:28px 0 6px}code{background:#eee;padding:1px 5px;border-radius:3px}</style>
<h1>${slug} — ${crops.length} campo(s) creado(s)</h1>
<p>prompt: <code>${prompt}</code> · <a href="output.pdf">output.pdf</a> · <a href="summary.json">summary.json</a></p>
${crops.map(c => `<h2><code>${c.name}</code> — p${c.page} @(${Math.round(c.x)},${Math.round(c.y)}) ${Math.round(c.width)}×${Math.round(c.height)}pt</h2><img src="${c.img}">`).join('\n')}
<h2>Páginas completas (editado)</h2>
${[...outPages.keys()].sort((x, y) => x - y).map(p => `<img src="page-out-${p}.png">`).join('\n')}`;
    await writeFile(path.join(dir, 'index.html'), html);
    try {
      const s = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8'));
      s.fields = crops;
      await writeFile(path.join(dir, 'summary.json'), JSON.stringify(s, null, 2));
    } catch { /* summary puede no existir en --reuse */ }
    docsIndex.push(slug);
    console.log(`   ✓ ${dir}/index.html`);
  }

  await writeFile(path.join(outRoot, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>aldus-v2 eval</title><style>body{font:16px system-ui;margin:32px}</style><h1>aldus-v2 — eval placeholders→campos</h1><ul>${docsIndex.map(d => `<li><a href="${d}/index.html">${d}</a></li>`).join('')}</ul>`);
  console.log(`\n✓ Galería: ${outRoot}/index.html`);
}

main().catch(err => { console.error('✗', err); process.exit(1); });
