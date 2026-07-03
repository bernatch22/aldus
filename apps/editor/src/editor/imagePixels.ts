/**
 * imagePixels.ts — píxeles REALES de cada imagen del PDF (con su transparencia),
 * sacados de `page.objs` de pdf.js. El ghost de arrastre los usa en vez de
 * recortar el snapshot de la página: un crop del snapshot arrastra el FONDO que
 * la imagen tenía detrás (otra imagen), y en las zonas transparentes de un PNG
 * ese fondo se ve como "un pedazo de imagen pegado". Con los píxeles propios el
 * ghost es exacto y sin halo.
 *
 * Cache por documento (como el de colores): resolver + decodificar es caro.
 */
import type { ImageNode } from '@aldus/core';

/** imageId → dataURL PNG (preserva alpha). null = no se pudo (máscara, inline,
 *  aún no resuelta) → el caller cae al crop del snapshot. */
const cache = new Map<string, string | null>();

export function clearImagePixelCache(): void {
  cache.clear();
}

/** Objeto de imagen tal como lo entrega pdf.js en page.objs. */
interface PdfImageData {
  width: number;
  height: number;
  kind?: number; // 1=GRAYSCALE_1BPP, 2=RGB_24BPP, 3=RGBA_32BPP
  data?: Uint8ClampedArray | Uint8Array;
  bitmap?: CanvasImageSource; // ImageBitmap cuando pdf.js decodifica a bitmap
}

interface PdfObjs {
  has(objId: string): boolean;
  get(objId: string): unknown;
}

const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

/** Dibuja la imgData de pdf.js a un canvas y devuelve su dataURL, o null si el
 *  kind no es soportado. */
function imageToDataUrl(img: PdfImageData): string | null {
  const { width, height } = img;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    return canvas.toDataURL('image/png');
  }
  if (!img.data) return null;

  const out = ctx.createImageData(width, height);
  const dst = out.data;
  const src = img.data;
  if (img.kind === RGBA_32BPP) {
    dst.set(src.subarray(0, dst.length));
  } else if (img.kind === RGB_24BPP) {
    for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
      dst[j] = src[i]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i + 2]; dst[j + 3] = 255;
    }
  } else if (img.kind === GRAYSCALE_1BPP) {
    // 1 bit por pixel, empaquetado en bytes, filas alineadas a byte.
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const j = (y * width + x) * 4;
        dst[j] = v; dst[j + 1] = v; dst[j + 2] = v; dst[j + 3] = 255;
      }
    }
  } else {
    return null; // kind desconocido → fallback al snapshot
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Resuelve los píxeles limpios de cada imagen (cache primero). Best-effort:
 *  las que no se puedan devuelven null y el caller usa el snapshot. */
export function extractImagePixels(page: { objs: PdfObjs }, images: ImageNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const img of images) {
    if (cache.has(img.id)) {
      const v = cache.get(img.id);
      if (v) out.set(img.id, v);
      continue;
    }
    let url: string | null = null;
    try {
      const has = img.objId ? page.objs.has(img.objId) : false;
      if (img.objId && has) {
        const raw = page.objs.get(img.objId) as PdfImageData;
        url = imageToDataUrl(raw);
        console.log('[aldus:px]', img.id, 'objId=', img.objId, 'has=', has,
          'kind=', raw?.kind, 'bitmap=', !!raw?.bitmap, 'data=', raw?.data?.length,
          'wh=', raw?.width, 'x', raw?.height, 'url=', url ? `${url.slice(0, 30)}…(${url.length})` : null);
      } else {
        console.log('[aldus:px]', img.id, 'objId=', img.objId, 'has=', has, '→ sin pixels (fallback snapshot)');
      }
    } catch (e) {
      url = null; // objeto no resuelto / forma inesperada — cae al snapshot
      console.log('[aldus:px]', img.id, 'objId=', img.objId, 'THREW', e instanceof Error ? e.message : e);
    }
    cache.set(img.id, url);
    if (url) out.set(img.id, url);
  }
  return out;
}
