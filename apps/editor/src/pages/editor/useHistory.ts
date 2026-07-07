import { useCallback, useRef, useState } from 'react';

/**
 * Historial genérico — patrón MEMENTO: snapshots opacos `S` en pilas
 * undo/redo. `snapNow`/`restore` deben ser callbacks ESTABLES que lean el
 * estado por refs (nunca closures sobre el estado del render).
 */
export interface History {
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export function useHistory<S>(snapNow: () => S, restore: (snap: S) => void, limit = 100): History {
  const undoStack = useRef<S[]>([]);
  const redoStack = useRef<S[]>([]);
  const [, setTick] = useState(0); // fuerza re-render para habilitar botones

  const pushHistory = useCallback(() => {
    undoStack.current.push(snapNow());
    if (undoStack.current.length > limit) undoStack.current.shift();
    redoStack.current = [];
    setTick(t => t + 1);
  }, [snapNow, limit]);

  const undo = useCallback(() => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    redoStack.current.push(snapNow());
    restore(snap);
    setTick(t => t + 1);
  }, [snapNow, restore]);

  const redo = useCallback(() => {
    const snap = redoStack.current.pop();
    if (!snap) return;
    undoStack.current.push(snapNow());
    restore(snap);
    setTick(t => t + 1);
  }, [snapNow, restore]);

  const clear = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    setTick(t => t + 1);
  }, []);

  return {
    pushHistory,
    undo,
    redo,
    clear,
    get canUndo() {
      return undoStack.current.length > 0;
    },
    get canRedo() {
      return redoStack.current.length > 0;
    },
  };
}
