/**
 * store.test.ts — el GC de sesiones del demo público (audit-hosts §4.8):
 * una sesión sin actividad más vieja que el TTL se barre (dir + cache) y el
 * visitante que vuelve arranca fresco.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionStores } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'aldus-sessions-test-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('SessionStores GC', () => {
  it('barre sesiones vencidas por mtime y respeta las activas', () => {
    const stores = new SessionStores(root, { ttlMs: 60_000, sweepEveryMs: 0 });
    const sid = randomUUID();
    const store = stores.for(sid);
    store.create('doc.pdf', Buffer.from('%PDF-fake'));
    const dir = path.join(root, 'sessions', sid);
    expect(existsSync(dir)).toBe(true);

    // Recién creada: el sweep no la toca.
    expect(stores.sweep()).toBe(0);
    expect(existsSync(dir)).toBe(true);

    // "Pasó" el TTL (reloj inyectado): se barre dir + cache.
    expect(stores.sweep(Date.now() + 120_000)).toBe(1);
    expect(existsSync(dir)).toBe(false);

    // El visitante que vuelve arranca fresco (el cache no revive un dir muerto).
    const fresh = stores.for(sid);
    expect(existsSync(dir)).toBe(true);
    expect(fresh.list()).toEqual([]);
    stores.dispose();
  });
});
