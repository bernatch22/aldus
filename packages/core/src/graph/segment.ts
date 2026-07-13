/**
 * graph/segment.ts — la ENTIDAD Segment (audit-model §3): identidad readonly,
 * lecturas caras memoizadas con `once()`. Los nodos del grafo son INMUTABLES
 * (el grafo se REEMPLAZA entero en cada re-extract, nunca se muta) → memoizar
 * es seguro. En v1 `runLines`/`originalStyledRuns` se recalculaban en CADA
 * render (FloatingBar, Inspector, TextEditLayer, session los llaman N veces).
 *
 * Implementa la interface SegmentNode (compat estructural: los consumidores
 * tipados no cambian; `text` es un getter).
 *
 * REGLA DURA: la entidad JAMÁS normaliza/trimea texto — U+0012 y compañía
 * viajan intactos (o los acentos LibreOffice mueren en el bake). La creación
 * pasa SOLO por la factory de extract.
 */

import { once } from '../common/once.js';
import type { SegmentEdit } from '../model/edits.js';
import type { SegmentNode, TextRunNode, StyledRun } from '../model/nodes.js';
import { originalStyledRuns, runLines, segmentOriginal } from './segmentContent.js';
import { segmentText } from './tokens.js';

export class Segment implements SegmentNode {
  public readonly kind = 'segment' as const;

  private readonly memoLines = once(() => runLines(this));
  private readonly memoStyledRuns = once(() => originalStyledRuns(this));
  private readonly memoOriginal = once(() => segmentOriginal(this));
  private readonly memoText: () => string;

  constructor(
    public readonly id: string,
    public readonly page: number,
    public readonly runs: TextRunNode[],
    public readonly x: number,
    public readonly baseline: number,
    public readonly width: number,
    public readonly y: number,
    public readonly height: number,
    public readonly fontSize: number,
    /** Texto explícito (la factory lo computa igual que v1: segmentText por
     *  línea; bloques merged unen con '\n'). Ausente = derivado de runLines. */
    explicitText?: string,
  ) {
    this.memoText = explicitText !== undefined
      ? () => explicitText
      : once(() => this.memoLines().map(segmentText).join('\n'));
  }

  /** Texto reconstruido — misma regla que v1 (espacios inferidos, '\n' entre líneas). */
  public get text(): string {
    return this.memoText();
  }

  /** Las líneas visuales (runLines), memoizadas. */
  public lines(): TextRunNode[][] {
    return this.memoLines();
  }

  /** El contenido original como tramos estilados, memoizado. */
  public styledRuns(): StyledRun[] {
    return this.memoStyledRuns();
  }

  /** El snapshot original que el bake usa para localizar, congelado. */
  public original(): SegmentEdit['original'] {
    return this.memoOriginal();
  }
}
