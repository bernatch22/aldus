import { describe, expect, it } from 'vitest';
import { DisposableList, isDisposable, noOpDisposable } from './disposable.js';

describe('DisposableList', () => {
  it('disposes pushed items on dispose and reports isDisposed', () => {
    const list = new DisposableList();
    let disposed = false;
    list.push({ dispose: () => (disposed = true) });
    expect(list.isDisposed).toBe(false);
    list.dispose();
    expect(disposed).toBe(true);
    expect(list.isDisposed).toBe(true);
  });

  it('disposes late-pushed items immediately once disposed (leak-proof)', () => {
    const list = new DisposableList();
    list.dispose();
    let lateDisposed = false;
    list.push({ dispose: () => (lateDisposed = true) });
    expect(lateDisposed).toBe(true);
  });

  it('isDisposable guards correctly', () => {
    expect(isDisposable(noOpDisposable)).toBe(true);
    expect(isDisposable({})).toBe(false);
    expect(isDisposable(null)).toBe(false);
    expect(isDisposable('dispose')).toBe(false);
  });
});
