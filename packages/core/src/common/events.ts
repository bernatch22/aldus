import type { IDisposable } from './disposable.js';

/**
 * An event is a FUNCTION you call with a listener; it returns the
 * unsubscription as an IDisposable. Passing a `disposables` array
 * auto-registers the unsubscribe — the caller's teardown stays in one place.
 * (Pattern: vscode-js-debug src/common/events.ts)
 */
export type IEvent<T> = (
  listener: (event: T) => void,
  disposables?: IDisposable[],
) => IDisposable;

export class EventEmitter<T> implements IDisposable {
  private readonly listeners = new Set<(event: T) => void>();

  /** Expose `emitter.event` publicly; keep `fire()` for the owner only. */
  public readonly event: IEvent<T> = (listener, disposables) => {
    this.listeners.add(listener);
    let disposed = false;
    const disposable: IDisposable = {
      // Idempotent unsubscribe: double-dispose is a no-op, never an error.
      dispose: () => {
        if (!disposed) {
          disposed = true;
          this.listeners.delete(listener);
        }
      },
    };
    disposables?.push(disposable);
    return disposable;
  };

  public get size(): number {
    return this.listeners.size;
  }

  public fire(event: T): void {
    // Delivery snapshot: a listener that (un)subscribes mid-fire can neither
    // skip other listeners nor receive the event it subscribed during.
    for (const listener of [...this.listeners]) {
      // A listener removed by an earlier listener in THIS fire must not run.
      if (this.listeners.has(listener)) {
        listener(event);
      }
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}
