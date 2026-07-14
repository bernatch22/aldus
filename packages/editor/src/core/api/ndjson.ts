/**
 * api/ndjson.ts — lector de líneas NDJSON sobre un ReadableStream (v1:
 * `apps/editor/src/lib/ndjson.ts`, COPY verbatim — audit §2: "modelo de cómo
 * debe verse todo `common/`"). Llama `onLine` por cada línea JSON parseada
 * (las líneas vacías o malformadas se ignoran, nunca cortan el stream). El
 * streaming del agente lo usa.
 */
export async function readNdjson<T>(
  body: ReadableStream<Uint8Array>,
  onLine: (value: T) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed: T;
      try {
        parsed = JSON.parse(line) as T;
      } catch {
        continue;
      }
      onLine(parsed);
    }
  }
}
