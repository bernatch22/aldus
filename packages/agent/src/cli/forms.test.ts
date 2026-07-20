/**
 * forms.test.ts — los comandos determinísticos del CLI (`--fields`, `--fill`).
 *
 * Van contra un AcroForm REAL en disco, round-trip completo: crear → volcar →
 * completar → releer del archivo escrito. Sin mocks del motor: lo que se prueba
 * es justamente que el cableado del CLI no pierda nada por el camino.
 *
 * Dos contratos que estos tests fijan porque son los que hacen al comando
 * scriptable o inútil:
 *   · `--fields` escribe JSON LIMPIO en stdout (nada de avisos mezclados), así
 *     `aldus f.pdf --fields | jq` funciona.
 *   · `--fill` que no aplica NADA no escribe archivo — un PDF llamado
 *     "completado" idéntico a la entrada es peor que un error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFormFields } from '@aldus/core/bake';
import { runFields, runFill } from './forms.js';
import { CliError } from './ui.js';

/** Un PDF con los cuatro casos que importan: texto, checkbox, select con
 *  opciones y un campo read-only. */
async function makeFormPdf(): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  form.createTextField('nombre').addToPage(page, { x: 100, y: 700, width: 200, height: 20, font });
  form.createCheckBox('acepta').addToPage(page, { x: 100, y: 670, width: 14, height: 14 });
  const plan = form.createDropdown('plan');
  plan.addOptions(['Basico', 'Pro', 'Enterprise']);
  plan.addToPage(page, { x: 100, y: 640, width: 140, height: 20, font });
  const ro = form.createTextField('folio');
  ro.addToPage(page, { x: 100, y: 610, width: 100, height: 20, font });
  ro.enableReadOnly();

  const dir = await mkdtemp(path.join(tmpdir(), 'aldus-cli-'));
  const file = path.join(dir, 'form.pdf');
  await writeFile(file, await doc.save());
  return file;
}

/** Captura stdout (el canal del JSON) y silencia stderr (avisos). */
function captureStdout(): { out: () => string; restore: () => void } {
  let buf = '';
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk); return true;
  });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { out: () => buf, restore: () => { so.mockRestore(); se.mockRestore(); } };
}

afterEach(() => vi.restoreAllMocks());

describe('--fields', () => {
  it('vuelca JSON PARSEABLE con tipo, opciones, read-only y la posición de cada widget', async () => {
    const pdf = await makeFormPdf();
    const cap = captureStdout();
    await runFields(pdf);
    cap.restore();

    // Si esto tira, es que algún aviso se coló en stdout y rompió el pipe a jq.
    const fields = JSON.parse(cap.out()) as Array<Record<string, unknown>>;
    expect(fields.map(f => f.name).sort()).toEqual(['acepta', 'folio', 'nombre', 'plan']);

    const plan = fields.find(f => f.name === 'plan')!;
    expect(plan.type).toBe('select');
    expect(plan.options).toEqual(['Basico', 'Pro', 'Enterprise']);
    expect(fields.find(f => f.name === 'folio')!.readOnly).toBe(true);

    // La posición viaja: es lo que deja saber dónde caerá una firma. El ancho no
    // es exactamente el pedido (pdf-lib suma el borde del widget), así que se
    // verifica que sea la geometría REAL del campo, no un número inventado.
    const rects = fields.find(f => f.name === 'nombre')!.rects as Array<Record<string, number>>;
    expect(rects).toHaveLength(1);
    expect(rects[0]!.page).toBe(1);
    expect(rects[0]!.width).toBeGreaterThan(190);
    expect(rects[0]!.width).toBeLessThan(210);
    expect(rects[0]!.y).toBeGreaterThan(690);
  });

  it('un PDF sin formulario da [] y no rompe', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const dir = await mkdtemp(path.join(tmpdir(), 'aldus-cli-'));
    const file = path.join(dir, 'plain.pdf');
    await writeFile(file, await doc.save());

    const cap = captureStdout();
    await runFields(file);
    cap.restore();
    expect(JSON.parse(cap.out())).toEqual([]);
  });

  it('un archivo inexistente es un error de USO, no un ENOENT crudo', async () => {
    const cap = captureStdout();
    await expect(runFields('/no/existe.pdf')).rejects.toThrow(CliError);
    await expect(runFields('/no/existe.pdf')).rejects.toThrow(/no encontré el archivo/);
    cap.restore();
  });
});

describe('--fill', () => {
  it('completa por nombre y los valores se releen DEL ARCHIVO ESCRITO', async () => {
    const pdf = await makeFormPdf();
    const out = pdf.replace(/\.pdf$/, '.out.pdf');
    const cap = captureStdout();
    await runFill(pdf, { nombre: 'Ana Gómez', acepta: true, plan: 'Pro' }, out);
    cap.restore();

    const fields = await readFormFields(new Uint8Array(await readFile(out)));
    expect(fields.find(f => f.name === 'nombre')!.value).toBe('Ana Gómez');
    expect(fields.find(f => f.name === 'acepta')!.value).toBe('On');
    expect(fields.find(f => f.name === 'plan')!.value).toBe('Pro');
  });

  it('sin -o escribe a <nombre>.filled.pdf', async () => {
    const pdf = await makeFormPdf();
    const cap = captureStdout();
    await runFill(pdf, { nombre: 'Ana' });
    cap.restore();
    expect(existsSync(pdf.replace(/\.pdf$/, '.filled.pdf'))).toBe(true);
  });

  it('un campo bueno y uno inexistente: aplica el bueno y avisa del otro', async () => {
    const pdf = await makeFormPdf();
    const out = pdf.replace(/\.pdf$/, '.mixed.pdf');
    const cap = captureStdout();
    await runFill(pdf, { nombre: 'Ana', inexistente: 'x' }, out);
    cap.restore();

    expect(existsSync(out)).toBe(true);
    const fields = await readFormFields(new Uint8Array(await readFile(out)));
    expect(fields.find(f => f.name === 'nombre')!.value).toBe('Ana');
  });

  it('si NO se aplicó ningún campo, falla y NO deja archivo', async () => {
    const pdf = await makeFormPdf();
    const out = pdf.replace(/\.pdf$/, '.nada.pdf');
    const cap = captureStdout();
    // `folio` es read-only y `fantasma` no existe → 0 aplicados.
    await expect(runFill(pdf, { folio: 'F-1', fantasma: 'x' }, out)).rejects.toThrow(CliError);
    await expect(runFill(pdf, { folio: 'F-1' }, out)).rejects.toThrow(/no se completó ningún campo/);
    cap.restore();
    expect(existsSync(out)).toBe(false); // el punto: nada de un PDF que finge estar lleno
  });

  it('un objeto vacío se rechaza antes de tocar el PDF', async () => {
    const pdf = await makeFormPdf();
    const cap = captureStdout();
    await expect(runFill(pdf, {})).rejects.toThrow(/está vacío/);
    cap.restore();
  });

  it('--flatten deja el PDF sin campos (ya no es un formulario editable)', async () => {
    const pdf = await makeFormPdf();
    const out = pdf.replace(/\.pdf$/, '.flat.pdf');
    const cap = captureStdout();
    await runFill(pdf, { nombre: 'Ana', plan: 'Pro' }, out, true);
    cap.restore();

    expect(await readFormFields(new Uint8Array(await readFile(out)))).toEqual([]);
  });
});
