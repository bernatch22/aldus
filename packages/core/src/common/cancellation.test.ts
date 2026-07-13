import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CancellationTokenSource,
  NeverCancelled,
  TaskCancelledError,
  throwIfCancelled,
} from './cancellation.js';

describe('CancellationTokenSource', () => {
  it('cancel() flips the token and fires listeners exactly once', () => {
    const source = new CancellationTokenSource();
    let fires = 0;
    source.token.onCancellationRequested(() => fires++);
    expect(source.token.isCancellationRequested).toBe(false);
    source.cancel();
    source.cancel(); // idempotent
    expect(source.token.isCancellationRequested).toBe(true);
    expect(fires).toBe(1);
  });

  it('a listener added AFTER cancellation fires immediately', () => {
    const source = new CancellationTokenSource();
    source.cancel();
    let fired = false;
    source.token.onCancellationRequested(() => (fired = true));
    expect(fired).toBe(true);
  });

  it('dispose() tears down without cancelling', () => {
    const source = new CancellationTokenSource();
    let fired = false;
    source.token.onCancellationRequested(() => (fired = true));
    source.dispose();
    expect(source.token.isCancellationRequested).toBe(false);
    expect(fired).toBe(false);
  });

  it('throwIfCancelled polls, NeverCancelled never fires', () => {
    const source = new CancellationTokenSource();
    expect(() => throwIfCancelled(source.token)).not.toThrow();
    source.cancel();
    expect(() => throwIfCancelled(source.token)).toThrow(TaskCancelledError);
    expect(() => throwIfCancelled(NeverCancelled)).not.toThrow();
    expect(NeverCancelled.onCancellationRequested(() => undefined).dispose).toBeTypeOf('function');
  });

  describe('withTimeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('self-cancels after ms', () => {
      const source = CancellationTokenSource.withTimeout(50);
      expect(source.token.isCancellationRequested).toBe(false);
      vi.advanceTimersByTime(49);
      expect(source.token.isCancellationRequested).toBe(false);
      vi.advanceTimersByTime(1);
      expect(source.token.isCancellationRequested).toBe(true);
    });

    it('dispose() before the deadline clears the timer (no late cancel)', () => {
      const source = CancellationTokenSource.withTimeout(50);
      source.dispose();
      vi.advanceTimersByTime(100);
      expect(source.token.isCancellationRequested).toBe(false);
    });
  });
});
