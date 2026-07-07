/**
 * DocStore — the persistence boundary of the server (Repository pattern).
 * Routes talk to this interface, never to the filesystem; swapping in an
 * S3/sqlite store is implementing this interface + one line in index.ts.
 *
 * `writePdf` snapshots the previous bytes as `<id>.rev-<timestamp>.pdf` and
 * keeps the newest `ALDUS_REVISIONS` (default 10) — coarse multi-level undo,
 * replacing the old single `.bak`.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
  readEdits(id: string): { edits: unknown[]; savedAt: string | null };
  writeEdits(id: string, edits: unknown[]): number;
  /** Revision filenames, newest first. */
  revisions(id: string): string[];
  /**
   * Restores the newest revision over the current PDF and pops it — the
   * server-side UNDO of the last write (instant ops: addText, insertImage,
   * createField, watermark…). Returns false when there is nothing to revert.
   */
  popRevision(id: string): boolean;
}

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

  readEdits(id: string): { edits: unknown[]; savedAt: string | null } {
    if (!existsSync(this.editsPath(id))) return { edits: [], savedAt: null };
    return JSON.parse(readFileSync(this.editsPath(id), 'utf8'));
  }

  writeEdits(id: string, edits: unknown[]): number {
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
