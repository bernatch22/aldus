/**
 * placeholderMatch.test.ts — el matching PURO de placeholders_to_fields (F4):
 * leader elástico + expansión + colocación directa, flex multi-línea con guion
 * de corte Word, barrido de huérfanos, y el guardrail XXXX. Todo sin EditSession
 * (función pura sobre ParaLine[]).
 *
 * TODO(F5): los tests de placeholders VÍA EditSession (guardrail que rechaza
 * edit_text, idempotencia por segunda llamada, roundtrip bake → widget real)
 * quedan para F5, cuando la fachada exista. Ver v1 agent/test/placeholders.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { matchPlaceholders, looksLikeLeaderRewrite } from './placeholderMatch.js';
import { paragraphOf, type LayoutEnv, type ParaLine } from './paragraph.js';
import type { PageGraph, SegmentNode } from '../model/nodes.js';
import { graphOf } from '../../test/helpers.js';

const ENV: LayoutEnv = { effBaseline: s => s.baseline, isRemoved: () => false };
const linesOf = (g: PageGraph, seg: SegmentNode): ParaLine[] => paragraphOf(g, seg, ENV).lines;
const ctxFor = (seg: SegmentNode) => ({ page: 1, fontSize: seg.fontSize, existingWidgets: [], queuedFields: [] });

const draw = async (fn: (page: import('pdf-lib').PDFPage, f: PDFFont) => void): Promise<PageGraph> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500, 400]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  fn(page, f);
  return graphOf(await doc.save());
};

describe('matchPlaceholders — colocación directa por charX', () => {
  it('leader elástico + expansión: 5 puntos pasados → campo sobre el run REAL', async () => {
    const g = await draw(p => p.drawText('NOMBRE: ..............................', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('NOMBRE'))!;

    const res = matchPlaceholders(linesOf(g, seg), [{ placeholder: '.....', name: 'nombre' }], ctxFor(seg));
    expect(res.error).toBeUndefined();
    expect(res.fields).toHaveLength(1);
    const field = res.fields[0]!;
    expect(field.name).toBe('nombre');

    const lib = await PDFDocument.create();
    const helv = await lib.embedFont(StandardFonts.Helvetica);
    const trueX0 = 60 + helv.widthOfTextAtSize('NOMBRE: ', 11);
    const trueW = helv.widthOfTextAtSize('.'.repeat(30), 11);
    // charXOf estima por pesos de clase de glifo → tolerancia holgada (±5pt).
    expect(Math.abs(field.x - trueX0)).toBeLessThanOrEqual(5);
    expect(Math.abs(field.width - trueW)).toBeLessThanOrEqual(5);
  });

  it('barrido: DOS runs de leaders, se pasa UNO → se crean DOS campos', async () => {
    const g = await draw(p => p.drawText('Fecha: .............. Lugar: ..............', { x: 60, y: 280, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('Fecha'))!;

    const res = matchPlaceholders(linesOf(g, seg), [{ placeholder: '.....', name: 'fecha' }], ctxFor(seg));
    expect(res.fields).toHaveLength(2);
    const byX = [...res.fields].sort((a, b) => a.x - b.x);
    expect(byX[0]!.name).toBe('fecha');        // el nombrado por el LLM
    expect(byX[1]!.name).toMatch(/^campo_/);   // el huérfano, auto-nombrado
  });

  it('flex multi-línea "..... [company legal name]" con guion Word → UN campo, label dropped', async () => {
    const g = await draw(p => {
      p.drawText('entered into by and between ........................... [company le-', { x: 60, y: 300, size: 10 });
      p.drawText('gal name], a company duly incorporated under the laws.', { x: 60, y: 287, size: 10 });
    });
    const seg = g.segments.find(s => s.text.includes('between'))!;

    const res = matchPlaceholders(
      linesOf(g, seg),
      [{ placeholder: '..... [company legal name]', name: 'company_legal_name' }],
      ctxFor(seg),
    );
    expect(res.fields).toHaveLength(1); // UN solo match — el label no genera un 2do campo
    const field = res.fields[0]!;
    expect(field.name).toBe('company_legal_name');
    // El campo cae en la LÍNEA del run largo de leaders (la primera, baseline 300).
    expect(Math.abs(field.y - (300 - 2))).toBeLessThanOrEqual(1);
    const lib = await PDFDocument.create();
    const helv = await lib.embedFont(StandardFonts.Helvetica);
    const trueX0 = 60 + helv.widthOfTextAtSize('entered into by and between ', 10);
    expect(Math.abs(field.x - trueX0)).toBeLessThanOrEqual(10);
  });

  it('placeholder no encontrado → error, cero campos', async () => {
    const g = await draw(p => p.drawText('NOMBRE: ..............', { x: 60, y: 300, size: 11 }));
    const seg = g.segments[0]!;
    const res = matchPlaceholders(linesOf(g, seg), [{ placeholder: 'INEXISTENTE', name: 'x' }], ctxFor(seg));
    expect(res.error).toBeDefined();
    expect(res.fields).toHaveLength(0);
  });

  it('idempotencia por overlap: el rect ya ocupado se saltea (nothingNew)', async () => {
    const g = await draw(p => p.drawText('NOMBRE: ..............................', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('NOMBRE'))!;
    // Primera pasada para saber dónde cae el campo.
    const first = matchPlaceholders(linesOf(g, seg), [{ placeholder: '.....', name: 'nombre' }], ctxFor(seg));
    const placed = first.fields[0]!;
    // Segunda pasada con ese rect ya en `queuedFields` → salteado.
    const res = matchPlaceholders(
      linesOf(g, seg),
      [{ placeholder: '.....', name: 'nombre' }],
      { page: 1, fontSize: seg.fontSize, existingWidgets: [], queuedFields: [{ x: placed.x, y: placed.y, width: placed.width }] },
    );
    expect(res.fields).toHaveLength(0);
    expect(res.nothingNew).toBe(true);
  });

  it('recorte al relleno: un placeholder SLOPPY que invade la etiqueta NO tapa la palabra (regresión "Banco: ....Direccion")', async () => {
    // Word justificado pega la palabra a los leaders en el mismo run. Si el LLM
    // marca de más ("......Direccion"), el campo debe caer SOLO sobre los puntos.
    const g = await draw(p => p.drawText('Banco: ....................Direccion .......', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('Banco'))!;

    const res = matchPlaceholders(linesOf(g, seg), [{ placeholder: '....................Direccion', name: 'banco' }], ctxFor(seg));
    const field = res.fields.find(f => f.name === 'banco')!;
    expect(field).toBeDefined();

    const lib = await PDFDocument.create();
    const helv = await lib.embedFont(StandardFonts.Helvetica);
    const dotsEnd = 60 + helv.widthOfTextAtSize('Banco: ' + '.'.repeat(20), 11);
    // El borde derecho del campo cae en/antes del fin de los puntos, NO sobre "Direccion".
    expect(field.x + field.width).toBeLessThanOrEqual(dotsEnd + 6);
  });
});

describe('matchPlaceholders — modo REESCRITURA (rellenos XXXX/xxx/***)', () => {
  it('relleno XXXX sin leader → needsReflow con holes rewrite al ancho útil (cero fields directos)', async () => {
    const g = await draw(p => p.drawText('regirá desde el XX de XXXXXX de XXXX en adelante.', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('regirá'))!;

    const res = matchPlaceholders(linesOf(g, seg), [
      { placeholder: 'XX', name: 'dia' },
      { placeholder: 'XXXXXX', name: 'mes' },
      { placeholder: 'XXXX', name: 'anio' },
    ], ctxFor(seg));
    expect(res.error).toBeUndefined();
    expect(res.needsReflow).toBe(true);
    expect(res.fields).toHaveLength(0); // la colocación es POST-reflow (placeFieldsInGaps)
    const named = res.holes!.filter(h => h.rewrite && !h.drop);
    expect(named).toHaveLength(3);
    // 'dia'/'mes'/'anio' matchean el hint NARROW (5.5×fs) — ancho útil, no el del "XX" impreso.
    for (const h of named) expect(h.target).toBeCloseTo(11 * 5.5, 1);
  });

  it('split defensivo: la FRASE "XX de XXXXXX de XXXX" como UN field → 3 holes (las palabras del medio NO son hueco)', async () => {
    const g = await draw(p => p.drawText('regirá desde el XX de XXXXXX de XXXX en adelante.', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('regirá'))!;

    const res = matchPlaceholders(linesOf(g, seg), [{ placeholder: 'XX de XXXXXX de XXXX', name: 'fecha_inicio' }], ctxFor(seg));
    expect(res.needsReflow).toBe(true);
    const named = res.holes!.filter(h => !h.drop && h.name);
    expect(named.map(h => h.name)).toEqual(['fecha_inicio', 'fecha_inicio_2', 'fecha_inicio_3']);
    // Ningún hole cubre los "de" (los rangos son solo los runs de X).
    const line = linesOf(g, seg)[0]!;
    for (const h of named) expect(line.text.slice(h.from, h.to)).toMatch(/^[xX]+$/);
  });

  it('barrido de rellenos: se pasa UN xxxx → TODOS los runs x/X del párrafo se convierten (auto-nombrados)', async () => {
    const g = await draw(p => p.drawText('Nombre: XXXXXXXX y documento xxxxxx del titular.', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('Nombre'))!;

    const res = matchPlaceholders(linesOf(g, seg), [{ placeholder: 'XXXXXXXX', name: 'nombre' }], ctxFor(seg));
    expect(res.needsReflow).toBe(true);
    const named = res.holes!.filter(h => !h.drop && h.name);
    expect(named).toHaveLength(2);
    expect(named[0]!.name).toBe('nombre');
    expect(named[1]!.name).toMatch(/^campo_/); // el huérfano, auto-nombrado
  });

  it('recorte al run: "el señor ***" (frase-contexto) → el hueco cubre SOLO el ***, las palabras sobreviven', async () => {
    const g = await draw(p => p.drawText('y el señor ***, identificado con DNI Nº ***, según poderes.', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('señor'))!;

    const res = matchPlaceholders(linesOf(g, seg), [
      { placeholder: 'el señor ***', name: 'nombre_apoderado' },
      { placeholder: 'DNI Nº ***', name: 'dni_apoderado' },
    ], ctxFor(seg));
    expect(res.needsReflow).toBe(true);
    const named = res.holes!.filter(h => !h.drop && h.name);
    expect(named).toHaveLength(2);
    const line = linesOf(g, seg)[0]!;
    // Cada hueco cubre EXACTAMENTE el run de asteriscos — ni "el señor" ni "DNI Nº".
    for (const h of named) expect(line.text.slice(h.from, h.to)).toBe('***');
  });

  it('frases-contexto SOLAPADAS ("XXXXXX de XXXX" + "de XXXX hasta") → sin error y sin huecos duplicados', async () => {
    const g = await draw(p => p.drawText('regirá desde el XX de XXXXXX de XXXX hasta el XXX de XXXXX.', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('regirá'))!;

    const res = matchPlaceholders(linesOf(g, seg), [
      { placeholder: 'el XX de', name: 'dia_inicio' },
      { placeholder: 'XXXXXX de XXXX', name: 'mes_inicio' },
      { placeholder: 'de XXXX hasta', name: 'anio_inicio' },  // solapa con el anterior
      { placeholder: 'el XXX de', name: 'dia_fin' },
      { placeholder: 'INEXISTENTE_TOTAL', name: 'fantasma' }, // no está: nota, NO error
    ], ctxFor(seg));
    expect(res.error).toBeUndefined();
    expect(res.needsReflow).toBe(true);
    const named = res.holes!.filter(h => !h.drop && h.name);
    // 5 runs de X en la línea (XX, XXXXXX, XXXX, XXX, XXXXX — el barrido cierra
    // los no pasados), CERO duplicados: los rangos no se solapan entre sí.
    expect(named).toHaveLength(5);
    const line = linesOf(g, seg)[0]!;
    for (const h of named) expect(line.text.slice(h.from, h.to)).toMatch(/^[xX]+$/);
    for (let i = 0; i < named.length; i++) {
      for (let j = i + 1; j < named.length; j++) {
        const a = named[i]!, b = named[j]!;
        expect(a.li !== b.li || a.to <= b.from || b.to <= a.from).toBe(true); // sin solape
      }
    }
    expect(res.notes.join(' ')).toContain('INEXISTENTE_TOTAL'); // el no-encontrado quedó anotado
  });

  it('una ETIQUETA no es un placeholder: "[denominación social...]" ANCLA al run de leaders adyacente (no se borra contenido)', async () => {
    const g = await draw(p => p.drawText('……………………. [denominacion social de la empresa], con domicilio en Lima.', { x: 60, y: 300, size: 10 }));
    const seg = g.segments.find(s => s.text.includes('denominacion'))!;

    // El LLM (visto con MiniMax) pasa la ETIQUETA como placeholder: sin leaders
    // ni rellenos adentro NO se convierte NI se reescribe — se usa de ancla y el
    // campo cae sobre los "……" pegados a ella. La etiqueta sobrevive.
    const res = matchPlaceholders(linesOf(g, seg), [
      { placeholder: '[denominacion social de la empresa]', name: 'empresa_nombre' },
    ], ctxFor(seg));
    expect(res.error).toBeUndefined();
    expect(res.needsReflow).toBeFalsy(); // la etiqueta NO disparó rewrite
    expect(res.fields).toHaveLength(1);
    expect(res.fields[0]!.name).toBe('empresa_nombre');
    // El campo arranca donde arrancan los leaders (x del segmento), no sobre la etiqueta.
    expect(res.fields[0]!.x).toBeLessThan(seg.x + 60);

    // Y una etiqueta SIN leaders al lado sí se rechaza con nota (cero campos, cero borrado).
    const g2 = await draw(p => p.drawText('la empresa [nombre pendiente] firmará el acta.', { x: 60, y: 300, size: 10 }));
    const seg2 = g2.segments[0]!;
    const res2 = matchPlaceholders(linesOf(g2, seg2), [{ placeholder: '[nombre pendiente]', name: 'x' }], ctxFor(seg2));
    expect(res2.fields).toHaveLength(0);
    expect((res2.error ?? '') + res2.notes.join(' ')).toContain('no es un placeholder');
  });

  it('leaders puros NO disparan reflow (el corpus con "....." queda en colocación directa)', async () => {
    const g = await draw(p => p.drawText('NOMBRE: ..............................', { x: 60, y: 300, size: 11 }));
    const seg = g.segments.find(s => s.text.includes('NOMBRE'))!;
    const res = matchPlaceholders(linesOf(g, seg), [{ placeholder: '.....', name: 'nombre' }], ctxFor(seg));
    expect(res.needsReflow).toBeFalsy();
    expect(res.fields).toHaveLength(1);
  });
});

describe('looksLikeLeaderRewrite — guardrail XXXX (def #1)', () => {
  it('reescribir leaders con relleno → true; texto normal → false', () => {
    expect(looksLikeLeaderRewrite('NOMBRE: ..............', 'NOMBRE: Juan Pérez')).toBe(true);
    expect(looksLikeLeaderRewrite('Fecha: ____________', 'Fecha: 01/01')).toBe(true);
    expect(looksLikeLeaderRewrite('Cliente Acme', 'Cliente Beta')).toBe(false); // sin leaders, no aplica
    expect(looksLikeLeaderRewrite('DATE: ......', 'DATE: ......')).toBe(false);  // sigue con leaders, ok
  });

  it('reescribir RELLENOS (XXXX/xxx/***) también es rewrite — el editor Gemini los emulaba con espacios/"DD"/"[Etiqueta]"', () => {
    // Vistos en un run real: espacios, siglas de fecha, y labels entre corchetes.
    expect(looksLikeLeaderRewrite('regirá desde el XX de XXXXXX de XXXX.', 'regirá desde el      de        de     .')).toBe(true); // emulación con ESPACIOS
    expect(looksLikeLeaderRewrite('desde el XXX de XXXXXX de XXXX.', 'desde el DD de MM de AAAA.')).toBe(true);
    // Un "XX" AISLADO corto no dispara (roman numeral / "siglo XX" es texto legítimo).
    expect(looksLikeLeaderRewrite('durante el siglo XX la industria', 'durante el siglo XIX la industria')).toBe(false);
    expect(looksLikeLeaderRewrite('representada por xxxxxxxx, con D.N.I. N° xxxxxx', 'representada por [Nombre], con D.N.I. N° [DNI]')).toBe(true);
    expect(looksLikeLeaderRewrite('el señor ***, identificado', 'el señor [nombre], identificado')).toBe(true);
    expect(looksLikeLeaderRewrite('Partida N° xxxxxxxxxxx del Registro', 'Partida N°            del Registro')).toBe(true);
    // El relleno que SOBREVIVE en el texto nuevo no es reescritura (edición legítima alrededor).
    expect(looksLikeLeaderRewrite('Nombre: xxxxxx (titular)', 'Nombre: xxxxxx (apoderado)')).toBe(false);
    // "exxon"/"Maxxx" dentro de palabra: no son rellenos.
    expect(looksLikeLeaderRewrite('la empresa Exxon SA', 'la empresa Chevron SA')).toBe(false);
  });
});
