/**
 * mutex.ts — serializa las mutaciones concurrentes (art-of-code C6: "serialize
 * racy mutations through a queue").
 *
 * Los agentes editores corren EN PARALELO (una página cada uno) para que la
 * latencia del turno sea la de la página más lenta, no la suma. Pero todos
 * mutan LA MISMA `EditSession` (un ledger, un bake, un PDF) — y sus tools
 * tienen `await` adentro (reflow hornea para medir), así que dos ediciones
 * simultáneas pueden intercalarse y pisarse el snapshot.
 *
 * La sesión no se toca: se serializa el ACCESO. El paralelismo queda donde
 * importa (esperar al modelo), la mutación queda ordenada.
 */
export type Mutex = <T>(fn: () => Promise<T>) => Promise<T>;

export function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn); // la cola sigue aunque el anterior falle
    tail = run.catch(() => undefined);
    return run as Promise<T>;
  };
}
