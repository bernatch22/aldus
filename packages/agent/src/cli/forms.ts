/**
 * cli/forms.ts — los comandos DETERMINÍSTICOS: `--fields` y `--fill`.
 *
 * Cero LLM, cero API key, cero grafo. `readFormFields`/`setFieldValues`/
 * `flattenForm` (core/create/*) son pdf-lib puro: bytes entran, bytes salen. Son
 * los comandos scriptables — los que ponés en un cron o un pipe — así que el
 * contrato importa: `--fields` escribe JSON limpio en stdout y TODO lo demás
 * (avisos, diagnósticos) va a stderr, para que `aldus f.pdf --fields | jq` ande.
 *
 * Por eso también viven acá y no en `cli.ts`: son testeables sin arrancar nada.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { flattenForm, readFormFields, setFieldValues } from '@aldus/core/bake';
import type { FillValues } from './flags.js';
import { DIM, GREEN, OFF, RED, fail } from './ui.js';

/** Lee el PDF a bytes. Un ENOENT crudo de Node ("ENOENT: no such file or
 *  directory, open '...'") es ruido: acá sale como error de uso. */
async function readPdf(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') fail(`no encontré el archivo: ${path}`);
    if (code === 'EISDIR') fail(`${path} es un directorio, no un PDF.`);
    throw err;
  }
}

/**
 * `aldus form.pdf --fields` — vuelca los campos como JSON.
 *
 * Cada campo trae nombre, tipo, valor actual, opciones y el rect de CADA widget
 * (un radio tiene uno por opción) con su página 1-based: alcanza para saber
 * exactamente dónde va a caer una firma.
 */
export async function runFields(pdf: string): Promise<void> {
  const fields = await readFormFields(await readPdf(pdf));
  process.stdout.write(JSON.stringify(fields, null, 2) + '\n');
  // A stderr para no ensuciar el JSON de un pipe.
  if (!fields.length) {
    process.stderr.write(`${DIM}(el PDF no tiene campos de formulario AcroForm)${OFF}\n`);
  }
}

/**
 * `aldus form.pdf --fill '{"nombre":"Ana"}'` — completa por NOMBRE de campo.
 *
 * `setFieldValues` nunca lanza por un campo problemático: devuelve `applied` y
 * `warnings` (nombre inexistente, read-only, opción de select inválida). Los
 * mostramos los dos — tragarse un warning acá es entregar un formulario a medio
 * llenar creyendo que salió bien.
 *
 * Si NO se aplicó ningún campo, no se escribe archivo: un PDF de salida idéntico
 * a la entrada, con nombre de "completado", es peor que un error visible.
 */
export async function runFill(
  pdf: string, values: FillValues, outFlag?: string, flatten = false,
): Promise<void> {
  const names = Object.keys(values);
  if (!names.length) fail('--fill: el objeto está vacío, no hay nada que completar.');

  const { pdf: filled, applied, warnings } = await setFieldValues(await readPdf(pdf), values);

  for (const w of warnings) process.stderr.write(`${RED}⚠ ${w}${OFF}\n`);
  if (!applied.length) {
    fail(`no se completó ningún campo (${names.length} pedido/s) — no escribo ningún archivo.\n`
      + '  Mirá los nombres reales con:  aldus ' + pdf + ' --fields');
  }

  process.stderr.write(`${DIM}completado: ${applied.length} campo/s${OFF}\n`);

  let bytes = filled;
  if (flatten) {
    // Aplanar DESPUÉS de llenar: quema los valores en la página y saca el
    // AcroForm, así el resultado ya no es editable como formulario. Aplana
    // TODOS los campos, no solo los que completamos.
    const res = await flattenForm(bytes);
    bytes = res.pdf;
    for (const w of res.warnings) process.stderr.write(`${RED}⚠ ${w}${OFF}\n`);
    process.stderr.write(`${DIM}aplanado: ${res.flattened.length} campo/s (ya no es editable)${OFF}\n`);
  }

  const outPath = outFlag ?? pdf.replace(/\.pdf$/i, '') + '.filled.pdf';
  await writeFile(outPath, bytes);
  process.stderr.write(`${GREEN}✓${OFF} → ${outPath}\n`);
}
