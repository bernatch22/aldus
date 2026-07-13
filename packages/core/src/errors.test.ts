import { describe, expect, it } from 'vitest';
import { createSilentError, createUserError, isStructuredError, ProtocolError } from './errors.js';

describe('errors', () => {
  it('createUserError / createSilentError build structured data', () => {
    const user = createUserError('No pude ubicar el segmento', 9001);
    expect(user).toEqual({ __errorMarker: true, code: 9001, format: 'No pude ubicar el segmento', showUser: true });
    const silent = createSilentError('internal detail', 9002);
    expect(silent.showUser).toBe(false);
    expect(silent.code).toBe(9002);
  });

  it('isStructuredError guards on the marker, not the shape', () => {
    expect(isStructuredError(createUserError('x', 1))).toBe(true);
    expect(isStructuredError({ code: 1, format: 'x', showUser: true })).toBe(false);
    expect(isStructuredError(null)).toBe(false);
    expect(isStructuredError(new Error('x'))).toBe(false);
  });

  it('ProtocolError carries the structure through throw', () => {
    const structured = createUserError('boom', 9003);
    try {
      throw new ProtocolError(structured);
    } catch (e) {
      const err = e as ProtocolError;
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ProtocolError');
      expect(err.message).toBe('boom');
      expect(err.error).toBe(structured);
    }
  });
});
