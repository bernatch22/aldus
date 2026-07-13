import type { IDisposable } from './disposable.js';
import { EventEmitter, type IEvent } from './events.js';

/**
 * Cooperative cancellation, js-debug style (src/common/cancellation.ts):
 * long-running work polls `isCancellationRequested` (cheap, synchronous)
 * and/or subscribes to `onCancellationRequested`.
 *
 * Contract subtleties:
 *  - Subscribing to an ALREADY-cancelled token fires the listener
 *    immediately (synchronously) — a late subscriber can never miss it.
 *  - Cancellation is one-way and idempotent: once requested it never resets,
 *    and a second `cancel()` does not re-fire.
 */
export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: IEvent<void>;
}

/** Token for callers with nothing to cancel — never fires, never cancelled. */
export const NeverCancelled: CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

export class CancellationTokenSource implements IDisposable {
  private cancelled = false;
  private readonly emitter = new EventEmitter<void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  public readonly token: CancellationToken = {
    onCancellationRequested: (listener, disposables) => {
      if (this.cancelled) {
        // Late subscriber to a dead token: deliver synchronously.
        listener(undefined as void);
        return { dispose: () => undefined };
      }
      return this.emitter.event(listener, disposables);
    },
  } as CancellationToken;

  constructor() {
    Object.defineProperty(this.token, 'isCancellationRequested', {
      get: () => this.cancelled,
    });
  }

  /**
   * A source that self-cancels after `ms`. The timer is cleared on
   * `dispose()`/`cancel()`, so completing the work in time leaks nothing.
   */
  public static withTimeout(ms: number): CancellationTokenSource {
    const source = new CancellationTokenSource();
    source.timer = setTimeout(() => source.cancel(), ms);
    return source;
  }

  public cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    this.clearTimer();
    this.emitter.fire(undefined as void);
    this.emitter.dispose();
  }

  /** Tears down timer + listeners WITHOUT requesting cancellation. */
  public dispose(): void {
    this.clearTimer();
    this.emitter.dispose();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** Error thrown by helpers that abandon work on cancellation. */
export class TaskCancelledError extends Error {
  constructor(message = 'Task cancelled') {
    super(message);
    this.name = 'TaskCancelledError';
  }
}

/** Throws TaskCancelledError if the token is already cancelled — the poll. */
export const throwIfCancelled = (token: CancellationToken): void => {
  if (token.isCancellationRequested) {
    throw new TaskCancelledError();
  }
};
