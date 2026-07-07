import { describe, expect, it } from 'vitest';
import { readNdjson } from './ndjson';

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
};

describe('readNdjson', () => {
  it('parsea una línea JSON por evento', async () => {
    const seen: unknown[] = [];
    await readNdjson(streamOf('{"a":1}\n{"a":2}\n'), v => seen.push(v));
    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('re-ensambla líneas partidas entre chunks', async () => {
    const seen: unknown[] = [];
    await readNdjson(streamOf('{"type":"te', 'xt","delta":"ho', 'la"}\n'), v => seen.push(v));
    expect(seen).toEqual([{ type: 'text', delta: 'hola' }]);
  });

  it('ignora líneas vacías y malformadas sin cortar el stream', async () => {
    const seen: unknown[] = [];
    await readNdjson(streamOf('\n{not json}\n{"ok":true}\n'), v => seen.push(v));
    expect(seen).toEqual([{ ok: true }]);
  });

  it('no emite la cola sin salto de línea final (protocolo NDJSON estricto)', async () => {
    const seen: unknown[] = [];
    await readNdjson(streamOf('{"a":1}\n{"a":2}'), v => seen.push(v));
    expect(seen).toEqual([{ a: 1 }]);
  });
});
