/**
 * ÁREA de texto por segmento (pt): el grip AMPLÍA el área tipeable (ancho Y
 * alto — el PDF no tiene "cajas"; es afordance del editor). Persiste por
 * documento en localStorage. `{w?, h?}` en puntos. (v1 COPY.)
 */
import { useCallback, useState } from 'react';

export function useAreaWidths(id: string) {
  const [areaWidths, setAreaWidths] = useState<Map<string, { w?: number; h?: number }>>(() => {
    try { return new Map(Object.entries(JSON.parse(localStorage.getItem(`aldus-areas-${id}`) || '{}') as Record<string, { w?: number; h?: number }>)); }
    catch { return new Map(); }
  });

  const onAreaWidth = useCallback((segId: string, area: { w?: number; h?: number } | null) => {
    setAreaWidths(prev => {
      const next = new Map(prev);
      if (area == null || (area.w == null && area.h == null)) next.delete(segId); else next.set(segId, area);
      localStorage.setItem(`aldus-areas-${id}`, JSON.stringify(Object.fromEntries(next)));
      return next;
    });
  }, [id]);

  return { areaWidths, onAreaWidth };
}
