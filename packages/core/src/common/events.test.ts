import { describe, expect, it } from 'vitest';
import type { IDisposable } from './disposable.js';
import { EventEmitter } from './events.js';

describe('EventEmitter', () => {
  it('delivers events and unsubscribes via the returned disposable', () => {
    const emitter = new EventEmitter<number>();
    const seen: number[] = [];
    const subscription = emitter.event(n => seen.push(n));
    emitter.fire(1);
    subscription.dispose();
    subscription.dispose(); // idempotent — double dispose is a no-op
    emitter.fire(2);
    expect(seen).toEqual([1]);
    expect(emitter.size).toBe(0);
  });

  it('auto-registers the unsubscribe into a disposables array', () => {
    const emitter = new EventEmitter<string>();
    const disposables: IDisposable[] = [];
    emitter.event(() => undefined, disposables);
    expect(disposables).toHaveLength(1);
    disposables[0]!.dispose();
    expect(emitter.size).toBe(0);
  });

  it('a listener unsubscribing mid-fire cannot skip the others', () => {
    const emitter = new EventEmitter<void>();
    const seen: string[] = [];
    const first = emitter.event(() => {
      seen.push('first');
      first.dispose();
    });
    emitter.event(() => seen.push('second'));
    emitter.fire();
    expect(seen).toEqual(['first', 'second']);
    emitter.fire();
    expect(seen).toEqual(['first', 'second', 'second']);
  });

  it('a listener removed by an earlier listener in the same fire does not run', () => {
    const emitter = new EventEmitter<void>();
    const seen: string[] = [];
    emitter.event(() => {
      seen.push('remover');
      victim.dispose();
    });
    const victim = emitter.event(() => seen.push('victim'));
    emitter.fire();
    expect(seen).toEqual(['remover']);
  });
});
