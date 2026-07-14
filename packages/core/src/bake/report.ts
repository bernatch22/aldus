/**
 * bake/report.ts — el reporte del bake como EVENTOS estructurados (audit §3.4,
 * la deuda transversal #1 de v1: strings castellanos como API de facto).
 *
 * Diseño:
 *  - {@link BakeEvent} `{code, nodeId?, params, severity}` es el dato canónico.
 *  - {@link BakeCodes} son API estable: los tests nuevos asertan por `code`.
 *  - UN formatter castellano ({@link formatBakeEvent}) renderiza cada evento a
 *    los strings de v1 **byte-idéntico** — la UI y los tests viejos hacen
 *    `.includes('al fondo')` / `.includes('eliminado')` sobre `applied` /
 *    `warnings` y NO pueden romper hasta que el último consumidor migre a
 *    codes (regla dura #3 del plan). No traducir/re-frasear JAMÁS.
 *  - {@link BakeReport} es el Builder (como v1): `finish()` devuelve los
 *    arrays compatibles + `events`.
 */

export type BakeSeverity = 'applied' | 'warning';

export interface BakeEvent {
  code: number;
  /** Id del nodo editado (segmentId/imageId/…), si aplica. */
  nodeId?: string;
  /** Parámetros del evento (conteos, nombres, razones) — datos, no prosa. */
  params: Record<string, string | number>;
  severity: BakeSeverity;
}

/** Códigos estables del bake: 1xxx = applied, 9xxx = warning. */
export const BakeCodes = {
  // applied — texto
  SegmentRelocated: 1001,
  SegmentRewritten: 1002,
  SegmentRemoved: 1003,
  SegmentFamilyChanged: 1004,
  // applied — imágenes
  ImageRelocated: 1101,
  ImageRemoved: 1102,
  ImageZOrdered: 1103,
  // applied — formas
  ShapeMoved: 1201,
  ShapeRemoved: 1202,
  // applied — widgets
  WidgetRelocated: 1301,
  WidgetRemoved: 1302,
  // applied — /Annots (highlight/link)
  AnnotEdited: 1401,
  AnnotRemoved: 1402,
  // applied — fuentes
  SubstituteFontUsed: 1501,
  // warnings
  SegmentNotLocated: 9001,
  DegenerateMatrix: 9003,
  RotatedImageUnsupported: 9004,
  PageOutOfRange: 9005,
  SubsetInsufficient: 9006,
  GlyphArtifactDropped: 9007,
  UnreadableStream: 9008,
  AnnotNotFound: 9009,
  NoAnnots: 9010,
  AnnotPageOutOfRange: 9011,
  ImageNotLocated: 9012,
  ShapeNotLocated: 9013,
  RotatedShapeUnsupported: 9014,
  WidgetNotLocated: 9015,
  WidgetRemoveFailed: 9016,
  NoAcroForm: 9017,
  UnrepresentableDropped: 9018,
  FallbackDrawFailed: 9019,
  /** Ningún IEditApplier reclamó el edit (kind desconocido) — v2 estructural. */
  UnclaimedEdit: 9020,
  /** Algún número del edit no es finito (NaN/Infinity/dx faltante) — emitirlo
   *  escribiría "NaN" en el content stream (PDF corrupto). No se toca. */
  InvalidGeometry: 9021,
} as const;

export type BakeCode = (typeof BakeCodes)[keyof typeof BakeCodes];

const plural = (n: string | number | undefined, suffix = 's'): string =>
  Number(n) > 1 ? suffix : '';

/**
 * EL formatter castellano — ÚNICO sitio de render (catch-site único, estilo
 * js-debug). Cada string es BYTE-IDÉNTICO al que emitía v1 en el mismo caso.
 */
const FORMATTERS: Record<number, (e: BakeEvent) => string> = {
  [BakeCodes.SegmentRelocated]: e => `${e.nodeId}: reubicado/escalado (${e.params.ops} op${plural(e.params.ops)})`,
  [BakeCodes.SegmentRewritten]: e => `${e.nodeId}: reescrito por tramos (${e.params.runs})`,
  [BakeCodes.SegmentRemoved]: e => `${e.nodeId}: eliminado`,
  [BakeCodes.SegmentFamilyChanged]: e => `${e.nodeId}: redibujado con fuente estándar (cambio de familia)`,
  [BakeCodes.ImageRelocated]: e => `${e.nodeId}: reubicada/escalada`,
  [BakeCodes.ImageRemoved]: e => `${e.nodeId}: eliminada`,
  [BakeCodes.ImageZOrdered]: e => `${e.nodeId}: enviada ${e.params.zOrder === 'back' ? 'al fondo' : 'al frente'}`,
  [BakeCodes.ShapeMoved]: e => `${e.nodeId}: movida/redimensionada`,
  [BakeCodes.ShapeRemoved]: e => `${e.nodeId}: eliminada`,
  [BakeCodes.WidgetRelocated]: e => `${e.nodeId}: campo "${e.params.fieldName}" reubicado/escalado`,
  [BakeCodes.WidgetRemoved]: e => `${e.nodeId}: campo "${e.params.fieldName}" eliminado`,
  [BakeCodes.AnnotEdited]: e => `${e.nodeId}: ${e.params.label} ${e.params.recolored ? 'recoloreado' : 'reubicado/escalado'}`,
  [BakeCodes.AnnotRemoved]: e => `${e.nodeId}: ${e.params.label} eliminado`,
  [BakeCodes.SubstituteFontUsed]: e => `fuente sustituta: ${e.params.name}${e.params.bold ? ' bold' : ''}${e.params.italic ? ' italic' : ''}`,
  [BakeCodes.SegmentNotLocated]: e => `${e.nodeId}: ${e.params.reason} — sin cambios`,
  [BakeCodes.DegenerateMatrix]: e => `${e.nodeId}: matriz degenerada — sin cambios`,
  [BakeCodes.RotatedImageUnsupported]: e => `${e.nodeId}: la imagen tiene rotación — mover/escalar no soportado aún, queda intacta`,
  [BakeCodes.PageOutOfRange]: e => `página ${e.params.page} fuera de rango — ediciones saltadas`,
  [BakeCodes.SubsetInsufficient]: e => `${e.nodeId}: ${e.params.substituted} tramo${plural(e.params.substituted)} sin fuente original disponible (estilo nuevo o subset insuficiente) — se dibuja con fuente sustituta`,
  [BakeCodes.GlyphArtifactDropped]: e => `p${e.params.page}: glifo sin identidad unicode (artefacto del PDF) descartado en "${e.params.text}…"`,
  [BakeCodes.UnreadableStream]: e => `página ${e.params.page}: ${e.params.message}`,
  [BakeCodes.AnnotNotFound]: e => `${e.nodeId}: no se encontró la anotación en su rect original — sin cambios`,
  [BakeCodes.NoAnnots]: e => `${e.nodeId}: la página no tiene /Annots — sin cambios`,
  [BakeCodes.AnnotPageOutOfRange]: e => `${e.nodeId}: página ${e.params.page} fuera de rango — sin cambios`,
  [BakeCodes.ImageNotLocated]: e => `${e.nodeId}: no se encontró el XObject en la posición original — sin cambios`,
  [BakeCodes.ShapeNotLocated]: e => `${e.nodeId}: no se encontró la forma en su posición original — sin cambios`,
  [BakeCodes.RotatedShapeUnsupported]: e => `${e.nodeId}: la forma tiene rotación — mover no soportado, queda intacta`,
  [BakeCodes.WidgetNotLocated]: e => `${e.nodeId}: campo "${e.params.fieldName}" no encontrado en su rect — sin cambios`,
  [BakeCodes.WidgetRemoveFailed]: e => `${e.nodeId}: no se pudo eliminar (${e.params.message})`,
  [BakeCodes.NoAcroForm]: () => 'el documento no tiene AcroForm — ediciones de campos saltadas',
  [BakeCodes.UnrepresentableDropped]: e => `p${e.params.page}: caracteres no representables descartados en "${e.params.text}…"`,
  [BakeCodes.FallbackDrawFailed]: e => `p${e.params.page}: no se pudo dibujar el reemplazo "${e.params.text}…"`,
  [BakeCodes.UnclaimedEdit]: e => `${e.nodeId}: ningún applier reconoce la edición (kind "${e.params.kind}") — sin cambios`,
  [BakeCodes.InvalidGeometry]: e => `${e.nodeId}: geometría inválida (número no finito) — sin cambios`,
};

/** Renderiza un evento al string castellano de v1 (byte-idéntico). */
export function formatBakeEvent(e: BakeEvent): string {
  const f = FORMATTERS[e.code];
  return f ? f(e) : `evento ${e.code}${e.nodeId ? ` (${e.nodeId})` : ''}`;
}

export interface BakeResult {
  pdf: Uint8Array;
  /** Los eventos estructurados (v2) — la fuente de verdad. */
  events: BakeEvent[];
  /** What was applied, per edit — strings v1, renderizados del formatter. */
  applied: string[];
  /** What was skipped or degraded, and why. Honesty over silence. */
  warnings: string[];
  /**
   * EXACT color (hex "#rrggbb") of every touched segment, read from the
   * content stream (fillColorRaw of the first geometry-matched op). The
   * editor uses it for ghosts — more faithful than sampling pixels.
   */
  colors: Record<string, string>;
}

/** Builder (v1 compat): acumula eventos + colores; `finish` arma el resultado. */
export class BakeReport {
  private readonly events: BakeEvent[] = [];
  private readonly colors: Record<string, string> = {};

  /** Registra un evento `applied`. */
  applied(code: BakeCode, nodeId: string | undefined, params: Record<string, string | number> = {}): void {
    this.events.push({ code, nodeId, params, severity: 'applied' });
  }

  /** Registra un evento `warning`. */
  warning(code: BakeCode, nodeId: string | undefined, params: Record<string, string | number> = {}): void {
    this.events.push({ code, nodeId, params, severity: 'warning' });
  }

  color(segmentId: string, hex: string): void {
    this.colors[segmentId] = hex;
  }

  finish(pdf: Uint8Array): BakeResult {
    return {
      pdf,
      events: [...this.events],
      applied: this.events.filter(e => e.severity === 'applied').map(formatBakeEvent),
      warnings: this.events.filter(e => e.severity === 'warning').map(formatBakeEvent),
      colors: this.colors,
    };
  }
}
