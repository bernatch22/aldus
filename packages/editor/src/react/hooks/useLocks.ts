/**
 * LOCKS: un nodo bloqueado es invisible al mouse (pointer-events none en el
 * overlay); persistido por documento en localStorage. Incluye el auto-lock de
 * imágenes full-page. (v1 COPY.)
 */
import { useCallback, useEffect, useState } from 'react';
import type { PageGraph } from '@aldus/core';

export function useLocks(id: string, graph: PageGraph | null) {
  const [locked, setLocked] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`aldus-locks-${id}`) || '[]') as string[]); }
    catch { return new Set(); }
  });

  const toggleLock = useCallback((nodeId: string) => {
    setLocked(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
      localStorage.setItem(`aldus-locks-${id}`, JSON.stringify([...next]));
      return next;
    });
  }, [id]);

  // Auto-lock de imágenes FULL-PAGE (fondos que cubren casi toda la hoja, como
  // el del insurance agreement): estorban al editar, así que nacen bloqueadas.
  // Se siembra UNA vez por imagen y por documento (marcador aparte, persistido):
  // si el usuario la desbloquea, no se vuelve a bloquear al recargar.
  useEffect(() => {
    if (!graph?.images.length) return;
    let seeded: Set<string>;
    try { seeded = new Set(JSON.parse(localStorage.getItem(`aldus-autolock-${id}`) || '[]') as string[]); }
    catch { seeded = new Set(); }
    const toLock: string[] = [];
    let seededChanged = false;
    for (const im of graph.images) {
      if (seeded.has(im.id)) continue;
      seeded.add(im.id);
      seededChanged = true;
      const coverage = (im.width * im.height) / (graph.width * graph.height);
      if (coverage >= 0.8) toLock.push(im.id);
    }
    if (seededChanged) localStorage.setItem(`aldus-autolock-${id}`, JSON.stringify([...seeded]));
    if (!toLock.length) return;
    setLocked(prev => {
      const next = new Set(prev);
      for (const nid of toLock) next.add(nid);
      localStorage.setItem(`aldus-locks-${id}`, JSON.stringify([...next]));
      return next;
    });
  }, [graph, id]);

  return { locked, toggleLock };
}
