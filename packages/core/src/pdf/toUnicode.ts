/**
 * pdf/toUnicode.ts — parsea el CMap /ToUnicode de una fuente (bfchar/bfrange) y
 * construye el mapa INVERSO unicode → bytes de código, para re-codificar texto
 * NUEVO con la fuente original (embebida/subseteada) del PDF.
 *
 * Si un carácter no está en el mapa, no está en el subset → el caller decide
 * (sustitución explícita con warning; nunca adivinar).
 *
 * Trasplante VERBATIM de v1 bake/toUnicode.ts.
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
  for (let i = 0; i + 1 < bytes.length; i += 2) units.push((bytes[i]! << 8) | bytes[i + 1]!);
  return String.fromCharCode(...units);
};

export function parseToUnicode(cmapText: string): ReverseEncoder {
  // unicode (string JS, puede ser par sustituto) → bytes de código fuente
  const map = new Map<string, number[]>();
  // ¿Todos los códigos fuente son de 1 byte? (fuente simple; habilita el
  // fallback identidad para control chars — ver encode()).
  let allOneByte = true;

  const hexRe = /<([0-9a-fA-F]+)>/g;
  const takeHexes = (chunk: string): string[] => {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    hexRe.lastIndex = 0;
    while ((m = hexRe.exec(chunk))) out.push(m[1]!);
    return out;
  };

  // bfchar: <src> <dst>
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m: RegExpExecArray | null;
  while ((m = bfcharRe.exec(cmapText))) {
    const hexes = takeHexes(m[1]!);
    for (let i = 0; i + 1 < hexes.length; i += 2) {
      const src = hexToBytes(hexes[i]!);
      if (src.length > 1) allOneByte = false;
      const uni = bytesToUnicode(hexToBytes(hexes[i + 1]!));
      if (uni && !map.has(uni)) map.set(uni, src);
    }
  }

  // bfrange: <lo> <hi> <dstStart>  |  <lo> <hi> [<dst> <dst> ...]
  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrangeRe.exec(cmapText))) {
    const body = m[1]!;
    const lineRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[\s\S]*?\])/g;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(body))) {
      const lo = parseInt(lm[1]!, 16);
      const hi = parseInt(lm[2]!, 16);
      const codeLen = Math.ceil(lm[1]!.length / 2);
      if (codeLen > 1) allOneByte = false;
      const dst = lm[3]!;
      const codeBytes = (code: number): number[] => {
        const out: number[] = [];
        for (let k = codeLen - 1; k >= 0; k--) out.push((code >> (8 * k)) & 0xff);
        return out;
      };
      if (dst.startsWith('[')) {
        const dsts = takeHexes(dst);
        for (let c = lo, idx = 0; c <= hi && idx < dsts.length; c++, idx++) {
          const uni = bytesToUnicode(hexToBytes(dsts[idx]!));
          if (uni && !map.has(uni)) map.set(uni, codeBytes(c));
        }
      } else {
        const startBytes = hexToBytes(dst.replace(/[<>]/g, ''));
        const startUnits: number[] = [];
        for (let i = 0; i + 1 < startBytes.length; i += 2) startUnits.push((startBytes[i]! << 8) | startBytes[i + 1]!);
        for (let c = lo; c <= hi && c - lo < 0x10000; c++) {
          const units = [...startUnits];
          units[units.length - 1] = units[units.length - 1]! + (c - lo);
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
        if (!bytes) {
          // ARTEFACTO de extracción: un código SIN entrada ToUnicode llega del
          // grafo como el código CRUDO (control char U+0000-U+001F — jamás es
          // texto legítimo). Re-encodearlo IDENTIDAD (char 0x12 → byte 0x12)
          // reproduce el GLIFO ORIGINAL EXACTO en la misma fuente (el acento
          // suelto de LibreOffice, p.ej.). Solo fuentes de códigos de 1 byte;
          // sin esto, el char caía a la sustituta → .notdef → cajita con X.
          const cp = ch.codePointAt(0)!;
          if (allOneByte && cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) {
            out.push(cp);
            continue;
          }
          return null;
        }
        out.push(...bytes);
      }
      return Uint8Array.from(out);
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Fuentes SIMPLES sin /ToUnicode (típico Word/Quartz: TrueType subseteada con
 * /MacRomanEncoding o /WinAnsiEncoding): el encoding estándar YA define el mapa
 * unicode → byte. Sin esto, cualquier reescritura caía a fuente estándar
 * (métricas distintas → texto desalineado) aunque la original pudiera
 * renderizar el texto perfectamente.
 * ──────────────────────────────────────────────────────────────────────────── */

/** MacRoman 0x80–0xFF → code points unicode (0x00–0x7F es ASCII). Tabla de
 *  Apple, en escapes numéricos para que ningún editor/normalizador la corrompa. */
// prettier-ignore
const MAC_ROMAN_HI: number[] = [
  0xc4, 0xc5, 0xc7, 0xc9, 0xd1, 0xd6, 0xdc, 0xe1, 0xe0, 0xe2, 0xe4, 0xe3, 0xe5, 0xe7, 0xe9, 0xe8,
  0xea, 0xeb, 0xed, 0xec, 0xee, 0xef, 0xf1, 0xf3, 0xf2, 0xf4, 0xf6, 0xf5, 0xfa, 0xf9, 0xfb, 0xfc,
  0x2020, 0xb0, 0xa2, 0xa3, 0xa7, 0x2022, 0xb6, 0xdf, 0xae, 0xa9, 0x2122, 0xb4, 0xa8, 0x2260, 0xc6, 0xd8,
  0x221e, 0xb1, 0x2264, 0x2265, 0xa5, 0xb5, 0x2202, 0x2211, 0x220f, 0x3c0, 0x222b, 0xaa, 0xba, 0x3a9, 0xe6, 0xf8,
  0xbf, 0xa1, 0xac, 0x221a, 0x192, 0x2248, 0x2206, 0xab, 0xbb, 0x2026, 0xa0, 0xc0, 0xc3, 0xd5, 0x152, 0x153,
  0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0xf7, 0x25ca, 0xff, 0x178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0xb7, 0x201a, 0x201e, 0x2030, 0xc2, 0xca, 0xc1, 0xcb, 0xc8, 0xcd, 0xce, 0xcf, 0xcc, 0xd3, 0xd4,
  0xf8ff, 0xd2, 0xda, 0xdb, 0xd9, 0x131, 0x2c6, 0x2dc, 0xaf, 0x2d8, 0x2d9, 0x2da, 0xb8, 0x2dd, 0x2db, 0x2c7,
];

/** WinAnsi (cp1252) 0x80–0x9F → code points (0 = código sin asignar en cp1252).
 *  El resto del rango alto (0xA0–0xFF) es latin-1 idéntico. */
// prettier-ignore
const WIN_ANSI_80_9F: number[] = [
  0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178,
];

function encodingChar(encoding: 'MacRomanEncoding' | 'WinAnsiEncoding', code: number): string {
  if (code < 0x80) return String.fromCharCode(code);
  const cp = encoding === 'MacRomanEncoding'
    ? MAC_ROMAN_HI[code - 0x80]
    : code <= 0x9f ? WIN_ANSI_80_9F[code - 0x80] : code;
  return cp ? String.fromCodePoint(cp) : '';
}

/**
 * Encoder inverso desde un encoding ESTÁNDAR de fuente simple, restringido a los
 * códigos presentes en el subset ([firstChar..lastChar], y con width > 0 si la
 * tabla /Widths está disponible — width 0 delata un glifo ausente).
 */
export function encoderFromSimpleEncoding(
  encoding: 'MacRomanEncoding' | 'WinAnsiEncoding',
  firstChar: number,
  lastChar: number,
  widths: number[] | null,
): ReverseEncoder {
  const map = new Map<string, number>();
  for (let code = firstChar; code <= lastChar && code <= 0xff; code++) {
    if (widths && !(widths[code - firstChar]! > 0)) continue;
    const uni = encodingChar(encoding, code);
    if (uni && !map.has(uni)) map.set(uni, code);
  }
  return {
    encode(text: string): Uint8Array | null {
      const out: number[] = [];
      for (const ch of text) {
        const code = map.get(ch);
        if (code === undefined) return null;
        out.push(code);
      }
      return Uint8Array.from(out);
    },
  };
}
