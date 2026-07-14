/**
 * DocStore — the persistence boundary of the server (Repository pattern).
 * Routes talk to this interface, never to the filesystem; swapping in an
 * S3/sqlite store is implementing this interface + one bind in the
 * composition root (composition.ts).
 *
 * `writePdf` snapshots the previous bytes as `<id>.rev-<timestamp>.pdf` and
 * keeps the newest `maxRevisions` (ALDUS_REVISIONS, default 10) — coarse
 * multi-level undo, replacing the old single `.bak`.
 *
 * AJUSTES v2 sobre la copia v1 (audit-hosts §2):
 *  - edits tipados: `readEdits`/`writeEdits` hablan {@link AnyEdit} de core,
 *    no `unknown[]` — el contrato de ediciones tiene UNA fuente (core/model).
 *  - {@link SessionStores} con GC (riesgo §4.8: el demo público llenaba disco).
 *  - `popRevision` DOCUMENTADO como lo que es: deshace la última ESCRITURA del
 *    server (bake u op instantánea), no un undo semántico por tipo de cambio —
 *    un bake seguido de una op y un revert restaura el estado pre-op, no
 *    pre-bake. El editor lo cablea a su historial unificado sabiéndolo.
 */
import { randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createLogger, createToken, type AnyEdit } from '@aldus/core';

export interface DocMeta {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
}

export interface DocStore {
  create(name: string, bytes: Buffer): DocMeta;
  list(): DocMeta[];
  exists(id: string): boolean;
  /** Absolute path of the PDF on disk (the agent loads by path). */
  pdfPath(id: string): string;
  readPdf(id: string): Buffer;
  /** Overwrites the PDF, snapshotting the previous bytes as a revision. */
  writePdf(id: string, bytes: Uint8Array): void;
  readEdits(id: string): { edits: AnyEdit[]; savedAt: string | null };
  writeEdits(id: string, edits: AnyEdit[]): number;
  /** Revision filenames, newest first. */
  revisions(id: string): string[];
  /**
   * Restores the newest revision over the current PDF and pops it — the
   * server-side UNDO of the last WRITE (bake or instant op: addText,
   * insertImage, createField, watermark…), agnostic of what that write was.
   * Returns false when there is nothing to revert.
   */
  popRevision(id: string): boolean;
}

/** El store standalone (sin sesiones) — lo que binds la composition root. */
export const IDocStore = createToken<DocStore>('IDocStore');

export class FileDocStore implements DocStore {
  constructor(
    private readonly dir: string,
    private readonly maxRevisions = Number(process.env.ALDUS_REVISIONS || 10),
  ) {
    mkdirSync(dir, { recursive: true });
  }

  pdfPath(id: string): string {
    return path.join(this.dir, `${id}.pdf`);
  }

  private metaPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private editsPath(id: string): string {
    return path.join(this.dir, `${id}.edits.json`);
  }

  create(name: string, bytes: Buffer): DocMeta {
    const meta: DocMeta = {
      id: randomUUID(),
      name,
      size: bytes.length,
      uploadedAt: new Date().toISOString(),
    };
    writeFileSync(this.pdfPath(meta.id), bytes);
    writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2));
    return meta;
  }

  list(): DocMeta[] {
    return readdirSync(this.dir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.edits.json'))
      .map(f => JSON.parse(readFileSync(path.join(this.dir, f), 'utf8')) as DocMeta)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  exists(id: string): boolean {
    return existsSync(this.pdfPath(id));
  }

  readPdf(id: string): Buffer {
    return readFileSync(this.pdfPath(id));
  }

  writePdf(id: string, bytes: Uint8Array): void {
    this.snapshot(id);
    writeFileSync(this.pdfPath(id), Buffer.from(bytes));
  }

  readEdits(id: string): { edits: AnyEdit[]; savedAt: string | null } {
    if (!existsSync(this.editsPath(id))) return { edits: [], savedAt: null };
    return JSON.parse(readFileSync(this.editsPath(id), 'utf8'));
  }

  writeEdits(id: string, edits: AnyEdit[]): number {
    writeFileSync(this.editsPath(id), JSON.stringify({ edits, savedAt: new Date().toISOString() }, null, 2));
    return edits.length;
  }

  revisions(id: string): string[] {
    return readdirSync(this.dir)
      .filter(f => f.startsWith(`${id}.rev-`) && f.endsWith('.pdf'))
      .sort()
      .reverse();
  }

  popRevision(id: string): boolean {
    const [latest] = this.revisions(id);
    if (!latest) return false;
    const revPath = path.join(this.dir, latest);
    copyFileSync(revPath, this.pdfPath(id));
    unlinkSync(revPath);
    return true;
  }

  private snapshot(id: string): void {
    if (!this.exists(id)) return;
    copyFileSync(this.pdfPath(id), path.join(this.dir, `${id}.rev-${Date.now()}.pdf`));
    for (const stale of this.revisions(id).slice(this.maxRevisions)) {
      try {
        unlinkSync(path.join(this.dir, stale));
      } catch {
        /* already gone */
      }
    }
  }
}

const log = createLogger('aldus:server:sessions');

export interface SessionStoresOptions {
  /** Sesión sin actividad (mtime del archivo más nuevo) más vieja que esto → se
   *  barre. Default: 7 días (ALDUS_SESSION_TTL_HOURS lo fija en index.ts). */
  ttlMs?: number;
  /** Cada cuánto corre el sweep. Default: 1 h. 0 = solo el sweep del boot. */
  sweepEveryMs?: number;
}

/**
 * Per-session stores for the PUBLIC demo (privacy): every visitor (a `sid`
 * cookie) gets an isolated FileDocStore under `<root>/sessions/<sid>`, seeded
 * on first use with COPIES of the sample docs in `<root>/_samples`. Uploads and
 * edits never leak between visitors. Enabled by ALDUS_SESSION_SCOPED — the
 * standalone editor keeps its single shared store, unchanged.
 *
 * GC (audit-hosts §4.8 — v1 llenaba disco: cookie de 30 días, un dir por
 * visitante con PDFs de hasta 50 MB): un SWEEP por mtime corre al boot y cada
 * `sweepEveryMs` — toda sesión sin actividad hace más de `ttlMs` se borra
 * (dir + entrada de cache). El visitante que vuelve arranca fresco con los
 * samples re-seedeados: pierde SOLO sus uploads viejos, nunca los de otro.
 */
export class SessionStores {
  private readonly cache = new Map<string, FileDocStore>();
  private readonly ttlMs: number;
  private readonly timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly root: string, opts: SessionStoresOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 7 * 24 * 3600_000;
    const every = opts.sweepEveryMs ?? 3600_000;
    this.sweep();
    if (every > 0) {
      this.timer = setInterval(() => this.sweep(), every);
      this.timer.unref?.();
    }
  }

  for(sid: string): FileDocStore {
    const cached = this.cache.get(sid);
    if (cached) return cached;
    const dir = path.join(this.root, 'sessions', sid);
    const fresh = !existsSync(dir);
    const store = new FileDocStore(dir); // el ctor hace mkdir recursivo
    if (fresh) this.seedSamples(dir);
    this.cache.set(sid, store);
    return store;
  }

  /** Borra toda sesión sin actividad (mtime más nuevo) hace más de `ttlMs`. */
  sweep(now = Date.now()): number {
    const base = path.join(this.root, 'sessions');
    if (!existsSync(base)) return 0;
    let swept = 0;
    for (const sid of readdirSync(base)) {
      const dir = path.join(base, sid);
      try {
        if (now - this.newestMtime(dir) <= this.ttlMs) continue;
        rmSync(dir, { recursive: true, force: true });
        this.cache.delete(sid);
        swept++;
      } catch {
        /* sesión en uso o ya borrada — la agarra el próximo sweep */
      }
    }
    if (swept) log(`GC: ${swept} sesión(es) vencida(s) barrida(s)`);
    return swept;
  }

  /** Apaga el timer del sweep (tests / shutdown limpio). */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Último mtime dentro del dir (actividad real), o el del dir si está vacío. */
  private newestMtime(dir: string): number {
    let newest = statSync(dir).mtimeMs;
    for (const f of readdirSync(dir)) {
      try {
        newest = Math.max(newest, statSync(path.join(dir, f)).mtimeMs);
      } catch {
        /* borrado en carrera */
      }
    }
    return newest;
  }

  private seedSamples(dir: string): void {
    const samples = path.join(this.root, '_samples');
    if (!existsSync(samples)) return;
    for (const f of readdirSync(samples)) {
      // solo el PDF base y su meta — sin revisiones ni edits guardados
      if (f.includes('.rev-') || f.endsWith('.edits.json')) continue;
      copyFileSync(path.join(samples, f), path.join(dir, f));
    }
  }
}
