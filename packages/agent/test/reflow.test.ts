/**
 * reflow.test.ts — el motor de reflow determinístico VÍA la EditSession (que
 * cablea el ReflowEnv sobre el EditLedger + el `reExtract` inyectado). Espejo de
 * los casos 6–8 que F4 ya cubre en core/layout/reflow.test.ts, pero a través de
 * la fachada (replace_paragraph / edit_text), verificando el string de respuesta.
 *
 *  6. abort+restore: texto que NO entra ni comprimiendo → ⚠️ "No modifiqué nada"
 *  7. replaceParagraph que ACHICA → menos líneas y las baselines de abajo SUBEN
 *  8. editText que agrega renglones → nada pasa del margen, gaps respetados
 */
import { describe, expect, it } from 'vitest';
import { EditSession } from '../src/session/EditSession.js';
import { dumpRows, graphOf, pdfWith } from './helpers.js';

/** Párrafo de 4 renglones (leading 14 @11pt) + 2 líneas de contenido inferior. */
const PARA = [
  'El presente contrato se celebra entre las partes con el objeto de',
  'regular la prestación de servicios profesionales, incluyendo el',
  'alcance de las tareas, los plazos de entrega acordados y la forma',
  'de pago pactada entre ambas partes contratantes del servicio.',
];

const paraPdf = (opts: { bottomAt?: number } = {}) =>
  pdfWith([500, 700], (page, f) => {
    let y = 600;
    for (const line of PARA) { page.drawText(line, { x: 60, y, size: 11, font: f.regular }); y -= 14; }
    // Contenido INFERIOR: párrafo aparte (gap 30pt > 1.7×fontSize).
    page.drawText('Cláusula segunda: la vigencia del acuerdo será de un año.', { x: 60, y: y - 30, size: 11, font: f.regular });
    page.drawText('Firmas de las partes al pie del documento presente.', { x: 60, y: y - 44, size: 11, font: f.regular });
    // Página "llena": contenido pegado al MARGIN_FLOOR (58) → cero slack.
    if (opts.bottomAt != null) page.drawText('Texto que llena el resto de la página hasta el fondo.', { x: 60, y: opts.bottomAt, size: 11, font: f.regular });
  });

describe('reflow de párrafo (determinístico, bake+medición real)', () => {
  it('6. replaceParagraph que NO entra ni comprimiendo → aborta y NO toca nada', async () => {
    const doc = await graphOf(await paraPdf({ bottomAt: 60 }));
    const before = doc.pages[0]!.segments.map(s => `${s.text}@${Math.round(s.baseline)}`).join('|');
    const session = new EditSession(doc);
    const first = doc.pages[0]!.segments.find(s => s.text.startsWith('El presente'))!;
    const long =
      'Este texto nuevo es muchísimo más largo que el párrafo original y pretende ocupar una cantidad de renglones que la página, que ya está completamente llena hasta el margen inferior, no puede alojar de ninguna manera razonable. '.repeat(4);
    const msg = await session.replaceParagraph(first.id, long);
    expect(msg).toContain('⚠️');
    expect(msg).toContain('No modifiqué nada');
    // Abort+restore: la sesión quedó VACÍA (ley: lo que no puede hacer bien, no lo toca).
    expect(session.count).toBe(0);
    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    expect(re.pages[0]!.segments.map(s => `${s.text}@${Math.round(s.baseline)}`).join('|')).toBe(before);
  }, 60_000);

  it('7. replaceParagraph que ACHICA → menos líneas y el contenido inferior SUBE', async () => {
    const doc = await graphOf(await paraPdf());
    const session = new EditSession(doc);
    const first = doc.pages[0]!.segments.find(s => s.text.startsWith('El presente'))!;
    const belowBefore = doc.pages[0]!.segments.find(s => s.text.startsWith('Cláusula'))!.baseline; // 514

    const msg = await session.replaceParagraph(first.id, 'Contrato breve de servicios entre las partes.');
    expect(msg).toContain('✓');
    expect(msg).toMatch(/−\d+ renglón/); // liberó renglones
    expect(msg).toContain('SUBIDO');

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    const paraLines = re.pages[0]!.segments.filter(s => s.baseline > 550);
    expect(paraLines.length).toBeLessThan(PARA.length); // el párrafo se achicó (4 → menos)
    const belowAfter = re.pages[0]!.segments.find(s => s.text.startsWith('Cláusula'))!;
    expect(belowAfter.baseline).toBeGreaterThan(belowBefore + 10); // subió a cerrar el hueco
    // Y subió una cantidad ENTERA de renglones (múltiplo del leading 14 ±1).
    const dy = belowAfter.baseline - belowBefore;
    expect(Math.abs(dy % 14)).toBeLessThanOrEqual(1);
  }, 60_000);

  it('8. editText que agrega renglones → nada pasa del margen derecho, gaps respetados, inferior corrido', async () => {
    const doc = await graphOf(await paraPdf());
    const paraZone = (g: typeof doc) => g.pages[0]!.segments.filter(s => s.baseline > 480 && s.x >= 55);
    const rightEdge = Math.max(...doc.pages[0]!.segments.filter(s => s.baseline > 530).map(s => s.x + s.width));
    const belowBefore = doc.pages[0]!.segments.find(s => s.text.startsWith('Cláusula'))!.baseline;
    const spaceW = 11 * 0.28; // el MIN_GAP del motor deriva de acá (0.7×spaceW)

    const session = new EditSession(doc);
    const last = doc.pages[0]!.segments.find(s => s.text.startsWith('de pago'))!;
    const msg = await session.editText(
      last.id,
      'de pago pactada entre ambas partes contratantes del servicio, incluyendo además los intereses moratorios aplicables, las penalidades por incumplimiento y el mecanismo de resolución de controversias acordado.',
    );
    expect(msg).toContain('✓');
    expect(msg).toMatch(/\+\d+ renglón/); // el párrafo creció

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    const dump = dumpRows(re.pages[0]!); // formato repro.mts (forense) para el diagnóstico

    // (a) NINGÚN run puede pasarse del borde derecho original (+3pt como el motor).
    for (const s of re.pages[0]!.segments.filter(x => x.baseline > 400)) {
      for (const run of s.runs) {
        expect(run.x + run.width, `run "${run.text.slice(0, 30)}" se pasa del borde\n${dump}`)
          .toBeLessThanOrEqual(rightEdge + 3);
      }
    }
    // (b) gaps mínimos: dentro de cada FILA VISUAL, ningún par de runs se pisa.
    // Fila = baseline del RUN: los renglones extra del reflow viven DENTRO del
    // último segmento (multilínea) desde el fix de fuente — agrupar por baseline
    // de segmento apilaría sus filas y daría solapes falsos.
    const rows = new Map<number, Array<{ x: number; width: number; text: string }>>();
    for (const s of re.pages[0]!.segments.filter(x => x.baseline > 400 && x.x >= 55)) {
      for (const run of s.runs) {
        const key = Math.round(run.baseline);
        const row = rows.get(key) ?? [];
        row.push(run);
        rows.set(key, row);
      }
    }
    for (const [, runs] of rows) {
      const flat = [...runs].sort((a, b) => a.x - b.x);
      for (let i = 1; i < flat.length; i++) {
        const gap = flat[i]!.x - (flat[i - 1]!.x + flat[i - 1]!.width);
        expect(gap, `gap entre "${flat[i - 1]!.text.slice(0, 20)}" y "${flat[i]!.text.slice(0, 20)}"\n${dump}`)
          .toBeGreaterThanOrEqual(spaceW * 0.7 - 0.5);
      }
    }
    // (c) el contenido inferior BAJÓ una cantidad entera de renglones.
    const belowAfter = re.pages[0]!.segments.find(s => s.text.startsWith('Cláusula'))!;
    expect(belowAfter.baseline).toBeLessThan(belowBefore - 10);
    expect(Math.abs((belowBefore - belowAfter.baseline) % 14)).toBeLessThanOrEqual(1);
    // (d) el párrafo ganó RENGLONES (filas visuales, no segmentos: los extra
    // viven dentro del último segmento como bloque multilínea).
    const visualRows = (segs: Array<{ text: string }>) =>
      segs.reduce((n, s) => n + s.text.split('\n').length, 0);
    expect(visualRows(paraZone(re))).toBeGreaterThan(visualRows(paraZone(doc)));
  }, 60_000);
});
