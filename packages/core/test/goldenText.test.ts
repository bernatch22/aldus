import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GoldenText, sanitizeNumbers } from './goldenText.js';

const goldensDir = join(dirname(fileURLToPath(import.meta.url)), 'goldens');

describe('GoldenText harness (smoke)', () => {
  let golden: GoldenText | undefined;

  afterEach(() => {
    // La disciplina js-debug: loggear sin asear = test roto.
    if (golden) expect(golden.hasUnassertedLogs()).toBe(false);
    golden = undefined;
  });

  it('sanitizes numbers and asserts against the committed golden', () => {
    golden = new GoldenText([sanitizeNumbers]);
    golden.log('segment relocated x=123.45 y=678.9 (page 3)');
    golden.log('bake applied 7 edits in 42ms');
    golden.assertLog(join(goldensDir, 'smoke.txt'));
  });

  it('hasUnassertedLogs is true until assertLog runs', () => {
    const g = new GoldenText();
    expect(g.hasUnassertedLogs()).toBe(false); // sin logs no hay deuda
    g.log('line');
    expect(g.hasUnassertedLogs()).toBe(true);
    g.assertLog(join(goldensDir, 'single-line.txt'));
    expect(g.hasUnassertedLogs()).toBe(false);
  });

  // Los dos tests de fallo apagan RESET_RESULTS: en modo regeneración
  // assertLog escribe en vez de fallar y el escenario no existe.
  const withoutReset = (fn: () => void) => {
    const saved = process.env.RESET_RESULTS;
    delete process.env.RESET_RESULTS;
    try {
      fn();
    } finally {
      if (saved !== undefined) process.env.RESET_RESULTS = saved;
    }
  };

  it('on mismatch dumps a .actual next to the golden and fails', () => withoutReset(() => {
    const dir = mkdtempSync(join(tmpdir(), 'aldus-golden-'));
    const goldenPath = join(dir, 'mismatch.txt');
    writeFileSync(goldenPath, 'expected content\n');
    const g = new GoldenText();
    g.log('actual content');
    expect(() => g.assertLog(goldenPath)).toThrow();
    expect(existsSync(`${goldenPath}.actual`)).toBe(true);
    expect(readFileSync(`${goldenPath}.actual`, 'utf8')).toBe('actual content\n');
  }));

  it('a missing golden asks for RESET_RESULTS instead of passing silently', () => withoutReset(() => {
    const g = new GoldenText();
    g.log('anything');
    expect(() => g.assertLog(join(tmpdir(), 'aldus-does-not-exist', 'nope.txt')))
      .toThrow(/RESET_RESULTS=1/);
  }));
});
