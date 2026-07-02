/**
 * tokenizer.ts — tokenizador del content stream de PDF (ISO 32000 §7.2/7.8).
 *
 * Produce la secuencia de OPERACIONES (operandos + operador) con los OFFSETS
 * de bytes reales, para poder extirpar o re-emitir un operador VERBATIM —
 * nunca re-serializamos lo que no tocamos.
 */

export interface Token {
  kind: 'num' | 'str' | 'hex' | 'name' | 'arr' | 'dict' | 'kw';
  /** num → valor; name → sin la barra; kw → la palabra. */
  value?: number | string;
  /** Slice textual EXACTO del source (para re-emitir verbatim). */
  raw: string;
  /** str/hex → bytes decodificados. */
  bytes?: Uint8Array;
  /** arr → tokens internos. */
  items?: Token[];
  start: number;
  end: number;
}

export interface OpRecord {
  op: string;
  operands: Token[];
  /** Rango de bytes [start, end) que cubre operandos + operador. */
  start: number;
  end: number;
}

const isWs = (c: number) => c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d ||
  c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

const latin1 = (bytes: Uint8Array, a: number, b: number): string => {
  let s = '';
  for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

export function tokenizeContentStream(src: Uint8Array): OpRecord[] {
  const ops: OpRecord[] = [];
  let operands: Token[] = [];
  let i = 0;
  const n = src.length;

  const skipWs = () => {
    while (i < n) {
      if (isWs(src[i])) { i++; continue; }
      if (src[i] === 0x25) { while (i < n && src[i] !== 0x0a && src[i] !== 0x0d) i++; continue; } // % comentario
      break;
    }
  };

  const parseString = (): Token => {
    const start = i;
    i++; // (
    const out: number[] = [];
    let depth = 1;
    while (i < n && depth > 0) {
      const c = src[i];
      if (c === 0x5c) { // backslash
        const e = src[i + 1];
        i += 2;
        if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(0x08);
        else if (e === 0x66) out.push(0x0c);
        else if (e === 0x28 || e === 0x29 || e === 0x5c) out.push(e);
        else if (e >= 0x30 && e <= 0x37) { // octal (1-3 dígitos)
          let v = e - 0x30;
          for (let k = 0; k < 2 && src[i] >= 0x30 && src[i] <= 0x37; k++) { v = v * 8 + (src[i] - 0x30); i++; }
          out.push(v & 0xff);
        } else if (e === 0x0a) { /* continuación de línea */ }
        else if (e === 0x0d) { if (src[i] === 0x0a) i++; }
        else if (e !== undefined) out.push(e);
      } else {
        if (c === 0x28) depth++;
        else if (c === 0x29) { depth--; if (depth === 0) { i++; break; } }
        out.push(c);
        i++;
        continue;
      }
    }
    return { kind: 'str', raw: latin1(src, start, i), bytes: Uint8Array.from(out), start, end: i };
  };

  const parseHex = (): Token => {
    const start = i;
    i++; // <
    const digits: number[] = [];
    while (i < n && src[i] !== 0x3e) {
      const c = src[i];
      if (!isWs(c)) digits.push(c);
      i++;
    }
    i++; // >
    let hex = digits.map(c => String.fromCharCode(c)).join('');
    if (hex.length % 2) hex += '0';
    const out = new Uint8Array(hex.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16);
    return { kind: 'hex', raw: latin1(src, start, i), bytes: out, start, end: i };
  };

  const parseName = (): Token => {
    const start = i;
    i++; // /
    let name = '';
    while (i < n && !isWs(src[i]) && !isDelim(src[i])) {
      if (src[i] === 0x23 && i + 2 < n) {
        name += String.fromCharCode(parseInt(latin1(src, i + 1, i + 3), 16));
        i += 3;
      } else {
        name += String.fromCharCode(src[i]);
        i++;
      }
    }
    return { kind: 'name', value: name, raw: latin1(src, start, i), start, end: i };
  };

  const parseNumber = (): Token => {
    const start = i;
    while (i < n && !isWs(src[i]) && !isDelim(src[i])) i++;
    const raw = latin1(src, start, i);
    return { kind: 'num', value: parseFloat(raw), raw, start, end: i };
  };

  const parseDict = (): Token => {
    const start = i;
    i += 2; // <<
    let depth = 1;
    while (i < n && depth > 0) {
      if (src[i] === 0x3c && src[i + 1] === 0x3c) { depth++; i += 2; continue; }
      if (src[i] === 0x3e && src[i + 1] === 0x3e) { depth--; i += 2; continue; }
      if (src[i] === 0x28) { parseString(); continue; }
      i++;
    }
    return { kind: 'dict', raw: latin1(src, start, i), start, end: i };
  };

  const parseArray = (): Token => {
    const start = i;
    i++; // [
    const items: Token[] = [];
    while (i < n) {
      skipWs();
      if (src[i] === 0x5d) { i++; break; }
      items.push(parseOne());
    }
    return { kind: 'arr', items, raw: latin1(src, start, i), start, end: i };
  };

  const parseKeyword = (): Token => {
    const start = i;
    while (i < n && !isWs(src[i]) && !isDelim(src[i])) i++;
    const kw = latin1(src, start, i);
    return { kind: 'kw', value: kw, raw: kw, start, end: i };
  };

  const parseOne = (): Token => {
    const c = src[i];
    if (c === 0x28) return parseString();
    if (c === 0x3c) return src[i + 1] === 0x3c ? parseDict() : parseHex();
    if (c === 0x2f) return parseName();
    if (c === 0x5b) return parseArray();
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) return parseNumber();
    return parseKeyword();
  };

  while (i < n) {
    skipWs();
    if (i >= n) break;
    const tok = parseOne();
    if (tok.kind === 'kw') {
      const op = tok.value as string;
      if (op === 'BI') {
        // Imagen inline: saltar hasta "EI" precedido de whitespace.
        while (i < n) {
          if (isWs(src[i - 1]) && src[i] === 0x45 && src[i + 1] === 0x49 && (i + 2 >= n || isWs(src[i + 2]) || isDelim(src[i + 2]))) {
            i += 2;
            break;
          }
          i++;
        }
        operands = [];
        continue;
      }
      ops.push({
        op,
        operands,
        start: operands.length ? operands[0].start : tok.start,
        end: tok.end,
      });
      operands = [];
    } else {
      operands.push(tok);
    }
  }
  return ops;
}
