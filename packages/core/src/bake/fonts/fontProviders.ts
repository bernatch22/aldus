/**
 * fontProviders.ts — providers de FUENTE para el fallback (path C).
 *
 * Cuando la fuente original no puede renderizar el texto nuevo (subset
 * insuficiente), antes de caer a la estándar de pdf-lib se prueba esta cadena
 * (mismo patrón que textEmitStrategies: probing en orden, el primero que
 * resuelve gana). Core NO registra ninguno: los providers con I/O (disco,
 * red) viven en `@aldus/core/node` y los bindea/registra el host Node
 * (server / CLI) — el browser nunca los carga (regla dura #5 del plan).
 *
 * v2: el contrato es multi-bindeable en el container ({@link IFallbackFontProvider}
 * como token) vía {@link bindFallbackFontProviders}; para compat npm se
 * conserva {@link registerFallbackFontProvider} como shim que agrega al
 * registry GLOBAL (el que {@link resolveFallbackFont} consulta por default —
 * el olvido de bindear pasa de bug silencioso a binding ausente visible).
 */
import { createToken, type Container } from '../../ioc/container.js';
import type { FontBucket } from '../../model/nodes.js';

export interface FallbackFontRequest {
  /** Familia original sin el prefijo de subset ("Cambria", no "CAAAAA+Cambria-Bold"). */
  family: string;
  bold: boolean;
  italic: boolean;
  bucket: FontBucket;
}

export interface ResolvedFallbackFont {
  /** Bytes TTF/OTF listos para embeber (fontkit). */
  bytes: Uint8Array;
  /** Nombre para el reporte ("Cambria (sistema)", "Caladea (métrica de Cambria)"). */
  name: string;
}

export interface IFallbackFontProvider {
  /** Devuelve la fuente para la familia+estilo, o null si no la tiene. Nunca tira. */
  resolve(req: FallbackFontRequest): Promise<ResolvedFallbackFont | null>;
}

/** Token de multi-bind: `container.bind(IFallbackFontProvider).toConstantValue(p)`. */
export const IFallbackFontProvider = createToken<IFallbackFontProvider>('IFallbackFontProvider');

/** Registry GLOBAL (default de resolveFallbackFont) — el shim de compat npm. */
const providers: IFallbackFontProvider[] = [];

/** Registrar un provider en el registry global (idempotente por identidad). */
export function registerFallbackFontProvider(p: IFallbackFontProvider): void {
  if (!providers.includes(p)) providers.push(p);
}

/** Vuelca los providers multi-bindeados de un container al registry global
 *  (para que un bake sin container inyectado — la API npm — los vea). */
export function adoptContainerFontProviders(container: Container): void {
  for (const p of container.getAll(IFallbackFontProvider)) registerFallbackFontProvider(p);
}

/** Probing en orden de registro; un provider roto no corta la cadena.
 *  `chain` inyectable (tests / bake con container); default = registry global. */
export async function resolveFallbackFont(
  req: FallbackFontRequest,
  chain: readonly IFallbackFontProvider[] = providers,
): Promise<ResolvedFallbackFont | null> {
  for (const p of chain) {
    try {
      const r = await p.resolve(req);
      if (r) return r;
    } catch { /* provider roto: seguir con el siguiente */ }
  }
  return null;
}
