import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';

/**
 * Golden-text snapshot harness: a test DESCRIBES a scenario and logs the
 * observed shape of reality; the log is compared against a committed .txt.
 * (Pattern: vscode-js-debug src/test/goldenText.ts.)
 *
 * Contract:
 *  - `RESET_RESULTS=1 pnpm test` regenerates every golden from the current
 *    behavior — the diff is the review.
 *  - On mismatch, the sanitized actual output is dumped next to the golden
 *    as `<golden>.actual` (gitignored) so you can diff/promote it by hand.
 *  - Sanitizers ([RegExp, replacement] pairs, applied in order to each line)
 *    keep goldens portable: offsets/ids/timestamps → placeholders like <n>.
 *  - A test that logged output but never called `assertLog` must FAIL: wire
 *    `expect(golden.hasUnassertedLogs()).toBe(false)` into `afterEach`.
 */
export type Sanitizer = readonly [RegExp, string];

/** Reemplaza todo número (enteros/decimales, con signo) por `<n>`. */
export const sanitizeNumbers: Sanitizer = [/-?\d+(?:\.\d+)?/g, '<n>'];

export class GoldenText {
  private readonly lines: string[] = [];
  private asserted = false;

  constructor(private readonly sanitizers: readonly Sanitizer[] = []) {}

  public log(line: string): void {
    this.lines.push(this.sanitize(line));
  }

  public hasUnassertedLogs(): boolean {
    return this.lines.length > 0 && !this.asserted;
  }

  public assertLog(goldenPath: string): void {
    this.asserted = true;
    const actual = this.lines.join('\n') + '\n';
    if (process.env.RESET_RESULTS) {
      writeFileSync(goldenPath, actual);
      return;
    }
    if (!existsSync(goldenPath)) {
      throw new Error(`Missing golden file ${goldenPath} — run with RESET_RESULTS=1 to create it`);
    }
    const expected = readFileSync(goldenPath, 'utf8');
    if (actual !== expected) {
      // Dump para diffear/promover a mano; el expect de abajo reporta el diff.
      writeFileSync(`${goldenPath}.actual`, actual);
    }
    expect(actual).toBe(expected);
  }

  private sanitize(line: string): string {
    let out = line;
    for (const [pattern, replacement] of this.sanitizers) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }
}
