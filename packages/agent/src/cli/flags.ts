/**
 * cli/flags.ts — el parser de flags del binario `aldus`.
 *
 * Vive aparte de `cli.ts` por una razón concreta: `cli.ts` corre `main()` al
 * importarse, así que nada de lo que viva ahí se puede testear. Acá el parser es
 * una función pura (argv → Flags, o {@link CliError}) y tiene sus tests.
 *
 * Cambio de comportamiento importante: una flag DESCONOCIDA ahora es un error.
 * Antes caía como argumento posicional, y el síntoma era desconcertante — un
 * `aldus doc.pdf --chat` no decía "no conozco --chat" sino "aldus <pdf> no lleva
 * prompt", porque `--chat` se colaba como si fuera el prompt.
 */
import { CliError, fail } from './ui.js';

/** Los valores que acepta `setFieldValues` (core/create/forms.ts). */
export type FillValues = Record<string, string | boolean | string[]>;

export interface Flags {
  positional: string[];
  out?: string;
  /** Páginas 1-based para el editor. undefined = todas. */
  pages?: number[];
  /** El reader elige las páginas (ruteo) en vez de `--pages`. */
  auto: boolean;
  fields: boolean;
  chat: boolean;
  flatten: boolean;
  /** Ya parseado y validado desde el JSON de `--fill`. */
  fill?: FillValues;
}

/** Las flags que toman un valor aparte (`--pages 1,3`). Sirve para el mensaje
 *  de error cuando el valor falta. */
const NEEDS_VALUE = new Set(['-o', '--out', '--page', '--pages', '--fill']);

function valueFor(flag: string, argv: string[], i: number): string {
  const v = argv[i];
  if (v === undefined || (v.startsWith('-') && NEEDS_VALUE.has(flag))) {
    fail(`${flag}: falta el valor.`);
  }
  return v;
}

/** "1,3" → [1, 3]. Rechaza basura en vez de editar páginas al azar. */
function parsePages(raw: string): number[] {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const pages = parts.map(Number);
  if (!pages.length || pages.some(n => !Number.isInteger(n) || n < 1)) {
    fail(`--pages: esperaba números de página 1-based separados por coma (p.ej. --pages 1,3), recibí "${raw}".`);
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}

/**
 * El JSON de `--fill` → el Record que come `setFieldValues`.
 *
 * Los números se aceptan y se pasan a string: `{"edad": 30}` es lo que cualquiera
 * escribe, y hacerlo fallar por no poner comillas sería hostil. Todo lo demás
 * (objetos anidados, null) se rechaza acá y no en las profundidades de pdf-lib.
 */
export function parseFillJson(raw: string): FillValues {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`--fill: JSON inválido (${err instanceof Error ? err.message : 'no se pudo parsear'}).\n`
      + `  Se espera un objeto {campo: valor}, p.ej.  --fill '{"nombre":"Ana","acepta":"true"}'`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`--fill: esperaba un OBJETO {campo: valor}, recibí ${Array.isArray(parsed) ? 'un array' : typeof parsed}.`);
  }
  const out: FillValues = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
    else if (Array.isArray(v) && v.every(x => typeof x === 'string')) out[k] = v as string[];
    else fail(`--fill: el campo "${k}" tiene un valor no soportado (${v === null ? 'null' : typeof v}). `
      + 'Se aceptan texto, número, booleano o lista de textos.');
  }
  return out;
}

export function parseFlags(argv: string[]): Flags {
  const positional: string[] = [];
  let out: string | undefined;
  let pages: number[] | undefined;
  let auto = false;
  let fields = false;
  let chat = false;
  let flatten = false;
  let fill: FillValues | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '-o': case '--out': out = valueFor(a, argv, ++i); break;
      case '--page': case '--pages': pages = parsePages(valueFor(a, argv, ++i)); break;
      case '--fill': fill = parseFillJson(valueFor(a, argv, ++i)); break;
      case '--auto': auto = true; break;
      case '--fields': fields = true; break;
      case '--chat': chat = true; break;
      case '--flatten': flatten = true; break;
      default:
        // `-` a secas es stdin por convención; lo dejamos pasar como posicional.
        if (a.startsWith('-') && a !== '-') {
          fail(`flag desconocida: ${a}\n  Corré \`aldus\` sin argumentos para ver las opciones.`);
        }
        positional.push(a);
    }
  }
  return { positional, out, pages, auto, fields, chat, flatten, fill };
}

export { CliError };
