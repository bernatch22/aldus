/**
 * Everything that holds a resource implements IDisposable — cleanup is an
 * explicit, one-method contract, never left to the garbage collector.
 * (Pattern: vscode-js-debug src/common/disposable.ts)
 */
export interface IDisposable {
  dispose(): void;
}

export const noOpDisposable: IDisposable = { dispose: () => undefined };

/**
 * Composite disposable. Safety property copied from js-debug: once the list
 * itself is disposed, anything pushed later is disposed IMMEDIATELY, so a
 * late registration can never leak.
 */
export class DisposableList implements IDisposable {
  private items: IDisposable[] = [];
  private disposed = false;

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public push<T extends IDisposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.push(item);
    return item;
  }

  public dispose(): void {
    this.disposed = true;
    const items = this.items;
    this.items = [];
    for (const item of items) {
      item.dispose();
    }
  }
}

export const isDisposable = (value: unknown): value is IDisposable =>
  typeof value === 'object'
  && value !== null
  && typeof (value as IDisposable).dispose === 'function';
