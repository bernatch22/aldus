/**
 * toUnicode.ts — parsea el CMap /ToUnicode de una fuente (bfchar/bfrange) y
 * construye el mapa INVERSO unicode → bytes de código, para re-codificar texto
 * NUEVO con la fuente original (embebida/subseteada) del PDF.
 *
 * Si un carácter no está en el mapa, no está en el subset → el caller decide
 * (sustitución explícita con warning; nunca adivinar).
 */

export interface ReverseEncoder {
  /** Codifica el texto completo, o null si algún carácter no está en el subset. */
  encode(text: string): Uint8Array | null;
}

const hexToBytes = (hex: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
};

const bytesToUnicode = (bytes: number[]): string => {
  // El destino de un bfchar/bfrange es UTF-16BE.
  const units: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) units.push((bytes[i] << 8) | bytes[i + 1]);
  return String.fromCharCode(...units);
};

export function parseToUnicode(cmapText: string): ReverseEncoder {
  // unicode (string JS, puede ser par sustituto) → bytes de código fuente
  const map = new Map<string, number[]>();

  const hexRe = /<([0-9a-fA-F]+)>/g;
  const takeHexes = (chunk: string): string[] => {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    hexRe.lastIndex = 0;
    while ((m = hexRe.exec(chunk))) out.push(m[1]);
    return out;
  };

  // bfchar: <src> <dst>
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m: RegExpExecArray | null;
  while ((m = bfcharRe.exec(cmapText))) {
    const hexes = takeHexes(m[1]);
    for (let i = 0; i + 1 < hexes.length; i += 2) {
      const uni = bytesToUnicode(hexToBytes(hexes[i + 1]));
      if (uni && !map.has(uni)) map.set(uni, hexToBytes(hexes[i]));
    }
  }

  // bfrange: <lo> <hi> <dstStart>  |  <lo> <hi> [<dst> <dst> ...]
  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrangeRe.exec(cmapText))) {
    const body = m[1];
    const lineRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[\s\S]*?\])/g;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(body))) {
      const lo = parseInt(lm[1], 16);
      const hi = parseInt(lm[2], 16);
      const codeLen = Math.ceil(lm[1].length / 2);
      const dst = lm[3];
      const codeBytes = (code: number): number[] => {
        const out: number[] = [];
        for (let k = codeLen - 1; k >= 0; k--) out.push((code >> (8 * k)) & 0xff);
        return out;
      };
      if (dst.startsWith('[')) {
        const dsts = takeHexes(dst);
        for (let c = lo, idx = 0; c <= hi && idx < dsts.length; c++, idx++) {
          const uni = bytesToUnicode(hexToBytes(dsts[idx]));
          if (uni && !map.has(uni)) map.set(uni, codeBytes(c));
        }
      } else {
        const startBytes = hexToBytes(dst.replace(/[<>]/g, ''));
        const startUnits: number[] = [];
        for (let i = 0; i + 1 < startBytes.length; i += 2) startUnits.push((startBytes[i] << 8) | startBytes[i + 1]);
        for (let c = lo; c <= hi && c - lo < 0x10000; c++) {
          const units = [...startUnits];
          units[units.length - 1] += c - lo;
          const uni = String.fromCharCode(...units);
          if (uni && !map.has(uni)) map.set(uni, codeBytes(c));
        }
      }
    }
  }

  return {
    encode(text: string): Uint8Array | null {
      const out: number[] = [];
      // Iterar por code points (los pares sustitutos viajan juntos).
      for (const ch of text) {
        const bytes = map.get(ch);
        if (!bytes) return null;
        out.push(...bytes);
      }
      return Uint8Array.from(out);
    },
  };
}
