/**
 * node/fontsNode.ts — providers de fuente con I/O REAL (solo Node; el browser
 * jamás importa este módulo — subpath `@aldus/core/node`). Trasplante VERBATIM
 * de v1 bake/fontsNode.ts.
 *
 * Cadena (en este orden):
 *  1) SYSTEM: la fuente ORIGINAL instalada en el sistema (macOS/Linux) —
 *     si el doc usa Cambria y la máquina la tiene, se embebe la de verdad.
 *  2) METRIC TWIN: gemela libre MÉTRICAMENTE COMPATIBLE, descargada de
 *     jsDelivr (fontsource) y cacheada en disco: Cambria→Caladea,
 *     Calibri→Carlito — mismos anchos por diseño, el layout no se mueve.
 *     Las propietarias (Cambria/Calibri son de Microsoft) no se pueden
 *     descargar legalmente; sus twins existen exactamente para esto.
 *
 * Offline / familia desconocida → null → la estándar de siempre. Nunca rompe.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  registerFallbackFontProvider,
  type FallbackFontRequest,
  type IFallbackFontProvider,
  type ResolvedFallbackFont,
} from '../bake/fonts/fontProviders.js';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Sufijos de estilo aceptados en el stem del archivo, por (bold, italic). */
const STYLE_SUFFIXES: Record<string, string[]> = {
  'false|false': ['', 'regular', 'rg'],
  'true|false': ['bold', 'bd', 'b'],
  'false|true': ['italic', 'oblique', 'it', 'i'],
  'true|true': ['bolditalic', 'boldoblique', 'bi', 'z'],
};

const FONT_DIRS = [
  join(homedir(), 'Library/Fonts'),
  '/Library/Fonts',
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  '/usr/share/fonts',
  '/usr/local/share/fonts',
];

/** Busca `<familia><sufijo>.ttf|otf` en los dirs de fuentes (1 nivel de
 *  subdirs en Linux). `.ttc` se salta: pdf-lib no embebe colecciones. */
function findSystemFont(family: string, bold: boolean, italic: boolean): string | null {
  const suffixes = STYLE_SUFFIXES[`${bold}|${italic}`]!;
  const wanted = suffixes.map(s => norm(family) + s);
  const scan = (dir: string, depth: number): string | null => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return null; }
    for (const e of entries) {
      const p = join(dir, e);
      const m = e.match(/^(.+)\.(ttf|otf)$/i);
      if (m && wanted.includes(norm(m[1]!))) return p;
      if (depth > 0) {
        try { if (statSync(p).isDirectory()) { const r = scan(p, depth - 1); if (r) return r; } } catch { /* permisos */ }
      }
    }
    return null;
  };
  for (const dir of FONT_DIRS) {
    const hit = scan(dir, 1);
    if (hit) return hit;
  }
  return null;
}

export class SystemFontProvider implements IFallbackFontProvider {
  async resolve(req: FallbackFontRequest): Promise<ResolvedFallbackFont | null> {
    const path = findSystemFont(req.family, req.bold, req.italic);
    if (!path) return null;
    return { bytes: new Uint8Array(readFileSync(path)), name: `${req.family} (sistema)` };
  }
}

/** familia original (normalizada) → paquete fontsource de su gemela métrica. */
const METRIC_TWINS: Record<string, { pkg: string; label: string }> = {
  cambria: { pkg: 'caladea', label: 'Caladea (métrica de Cambria)' },
  calibri: { pkg: 'carlito', label: 'Carlito (métrica de Calibri)' },
};

const cacheDir = () => process.env.ALDUS_FONT_CACHE || join(homedir(), '.aldus', 'fonts');

export class MetricTwinProvider implements IFallbackFontProvider {
  async resolve(req: FallbackFontRequest): Promise<ResolvedFallbackFont | null> {
    const twin = METRIC_TWINS[norm(req.family)];
    if (!twin) return null;
    // ¿La twin ya está instalada en el sistema? (LibreOffice trae Caladea/Carlito.)
    const local = findSystemFont(twin.pkg, req.bold, req.italic);
    if (local) return { bytes: new Uint8Array(readFileSync(local)), name: twin.label };
    // Cache en disco → una descarga por estilo, para siempre.
    const file = join(cacheDir(), `${twin.pkg}-${req.bold ? 700 : 400}-${req.italic ? 'italic' : 'normal'}.ttf`);
    if (existsSync(file)) return { bytes: new Uint8Array(readFileSync(file)), name: twin.label };
    const url = `https://cdn.jsdelivr.net/fontsource/fonts/${twin.pkg}@latest/latin-${req.bold ? 700 : 400}-${req.italic ? 'italic' : 'normal'}.ttf`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    try {
      mkdirSync(cacheDir(), { recursive: true });
      writeFileSync(file, bytes);
    } catch { /* cache best-effort: sin disco igual servimos los bytes */ }
    return { bytes, name: twin.label };
  }
}

/** Registrar los providers Node en el registry global (idempotente).
 *  Llamalo al boot del host — shim compat npm de v1. */
const system = new SystemFontProvider();
const metric = new MetricTwinProvider();
export function registerNodeFontProviders(): void {
  registerFallbackFontProvider(system);
  registerFallbackFontProvider(metric);
}
