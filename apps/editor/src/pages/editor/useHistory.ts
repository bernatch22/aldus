import { useCallback, useRef, useState } from 'react';

/**
 * Historial unificado — MEMENTO + COMMAND:
 *  - Entradas `snap`: snapshots opacos `S` del estado pendiente del editor
 *    (deshacer = restaurar el snapshot). `snapNow`/`restore` deben ser
 *    callbacks ESTABLES que lean el estado por refs.
 *  - Entradas `command`: operaciones de SERVER (crear texto/imagen/campo,
 *    watermark, links…) que ya escribieron el documento. Deshacer = revertir
 *    a la revisión previa del server; rehacer = re-ejecutar la operación.
 *    Sin esto, Ctrl+Z deshacía mover un nodo pero no haberlo creado.
 * Las entradas se intercalan en las mismas pilas, así el orden de deshacer
 * respeta el orden real de las acciones.
 */
export interface HistoryCommand {
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

type Entry<S> =
  | { kind: 'snap'; snap: S }
  | ({ kind: 'command' } & HistoryCommand);

export interface History {
  pushHistory: () => void;
  pushCommand: (command: HistoryCommand) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export function useHistory<S>(snapNow: () => S, restore: (snap: S) => void, limit = 100): History {
  const undoStack = useRef<Entry<S>[]>([]);
  const redoStack = useRef<Entry<S>[]>([]);
  const [, setTick] = useState(0); // fuerza re-render para habilitar botones

  const push = useCallback((entry: Entry<S>) => {
    undoStack.current.push(entry);
    if (undoStack.current.length > limit) undoStack.current.shift();
    redoStack.current = [];
    setTick(t => t + 1);
  }, [limit]);

  const pushHistory = useCallback(() => {
    push({ kind: 'snap', snap: snapNow() });
  }, [push, snapNow]);

  const pushCommand = useCallback((command: HistoryCommand) => {
    push({ kind: 'command', ...command });
  }, [push]);

  const undo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    if (entry.kind === 'snap') {
      redoStack.current.push({ kind: 'snap', snap: snapNow() });
      restore(entry.snap);
    } else {
      redoStack.current.push(entry);
      void entry.undo();
    }
    setTick(t => t + 1);
  }, [snapNow, restore]);

  const redo = useCallback(() => {
    const entry = redoStack.current.pop();
    if (!entry) return;
    if (entry.kind === 'snap') {
      undoStack.current.push({ kind: 'snap', snap: snapNow() });
      restore(entry.snap);
    } else {
      undoStack.current.push(entry);
      void entry.redo();
    }
    setTick(t => t + 1);
  }, [snapNow, restore]);

  const clear = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    setTick(t => t + 1);
  }, []);

  return {
    pushHistory,
    pushCommand,
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
