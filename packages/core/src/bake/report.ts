/**
 * BakeReport — accumulates what the bake did (Builder for {@link BakeResult}),
 * so `applied`/`warnings`/`colors` don't have to be threaded as three loose
 * arrays through every function.
 */

export interface BakeResult {
  pdf: Uint8Array;
  /** What was applied, per edit. */
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

export class BakeReport {
  private readonly applied: string[] = [];
  private readonly warnings: string[] = [];
  private readonly colors: Record<string, string> = {};

  apply(message: string): void {
    this.applied.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  color(segmentId: string, hex: string): void {
    this.colors[segmentId] = hex;
  }

  finish(pdf: Uint8Array): BakeResult {
    return { pdf, applied: this.applied, warnings: this.warnings, colors: this.colors };
  }
}
