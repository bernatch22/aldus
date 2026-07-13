import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, getTrace, traceEvent } from './log.js';

describe('log', () => {
  afterEach(() => {
    delete process.env.ALDUS_DEBUG;
    vi.restoreAllMocks();
  });

  it('createLogger is silent without ALDUS_DEBUG but still records the trace', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const log = createLogger('aldus:test-silent');
    log('quiet', { n: 1 });
    expect(spy).not.toHaveBeenCalled();
    const mine = getTrace().filter(e => e.ns === 'aldus:test-silent');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.msg).toBe('quiet {"n":1}');
  });

  it('createLogger prints when ALDUS_DEBUG is set (gating por env)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.ALDUS_DEBUG = '1';
    createLogger('aldus:test-loud')('hello', 42);
    expect(spy).toHaveBeenCalledWith('[aldus:test-loud]', 'hello', 42);
  });

  it('the trace is a ring buffer capped at 800 events', () => {
    for (let i = 0; i < 850; i++) traceEvent('aldus:test-ring', `evt ${i}`);
    const trace = getTrace();
    expect(trace.length).toBe(800);
    const ring = trace.filter(e => e.ns === 'aldus:test-ring');
    // Los primeros eventos se cayeron del buffer; el último sobrevive.
    expect(ring[ring.length - 1]!.msg).toBe('evt 849');
    expect(ring.some(e => e.msg === 'evt 0')).toBe(false);
  });
});
