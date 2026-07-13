import { type IDisposable, isDisposable } from '../common/disposable.js';

/**
 * Minimal hierarchical DI container — the hand-rolled essence of how
 * vscode-js-debug uses inversify (src/ioc.ts, src/ioc-extras.ts):
 *
 *  - A service identifier is a `Symbol` PAIRED with an interface of the same
 *    name: the symbol is the runtime token, the interface the compile-time
 *    type. Here the pairing is made explicit with a branded symbol so
 *    `container.get(IFoo)` infers `IFoo` with no type argument.
 *  - Containers form a hierarchy mirroring lifetimes (global → documento →
 *    página/bake): a child inherits every parent binding and may override.
 *  - MULTI-BINDING: bind N implementations to ONE token, consume with
 *    `getAll()` — the open registry behind extractors/appliers/strategies.
 *  - Disposal is DI-integrated (js-debug's `trackDispose`): every
 *    container-instantiated IDisposable is disposed by `container.dispose()`.
 *
 * Instead of decorators, constructor deps are declared with a static
 * `inject` tuple (`static inject = [IStore, all(IExporter)] as const`) —
 * same shape as `@inject`/`@multiInject`, zero dependencies.
 */
export type ServiceIdentifier<T> = symbol & { __service?: T };

export const createToken = <T>(name: string): ServiceIdentifier<T> =>
  Symbol(name) as ServiceIdentifier<T>;

/** Marker for multi-injection: resolves to `getAll(id)` (an array). */
export interface MultiInject<T> {
  readonly multi: ServiceIdentifier<T>;
}

export const all = <T>(id: ServiceIdentifier<T>): MultiInject<T> => ({ multi: id });

export type InjectSpec = ServiceIdentifier<unknown> | MultiInject<unknown>;

export interface Newable<T> {
  // deps arrive positionally from the static `inject` tuple
  new (...args: never[]): T;
  inject?: readonly InjectSpec[];
}

type Binding<T> =
  | { kind: 'constant'; value: T }
  | { kind: 'class'; ctor: Newable<T>; instance?: T };

export class Container implements IDisposable {
  private readonly bindings = new Map<symbol, Binding<unknown>[]>();
  private readonly instantiated: IDisposable[] = [];

  constructor(private readonly parent?: Container) {}

  public bind<T>(id: ServiceIdentifier<T>): {
    to(ctor: Newable<T>): void;
    toConstantValue(value: T): void;
  } {
    const push = (binding: Binding<T>) => {
      const list = this.bindings.get(id) ?? [];
      list.push(binding as Binding<unknown>);
      this.bindings.set(id, list);
    };
    return {
      to: ctor => push({ kind: 'class', ctor }),
      toConstantValue: value => push({ kind: 'constant', value }),
    };
  }

  /**
   * Resolves the LAST binding for the token, checking this container first,
   * then walking up — so a child override shadows the parent. Class bindings
   * are singletons scoped to the container that declared them.
   */
  public get<T>(id: ServiceIdentifier<T>): T {
    const own = this.bindings.get(id);
    const last = own?.[own.length - 1];
    if (last) {
      return this.resolve(last) as T;
    }
    if (this.parent) {
      return this.parent.get(id);
    }
    throw new Error(`No binding for service identifier ${String(id)}`);
  }

  /** All bindings for the token, parent-first — the multi-binding registry. */
  public getAll<T>(id: ServiceIdentifier<T>): T[] {
    const inherited = this.parent ? this.parent.getAll(id) : [];
    const own = (this.bindings.get(id) ?? []).map(binding => this.resolve(binding) as T);
    return [...inherited, ...own];
  }

  public createChild(): Container {
    return new Container(this);
  }

  private resolve(binding: Binding<unknown>): unknown {
    if (binding.kind === 'constant') {
      return binding.value;
    }
    if (binding.instance === undefined) {
      const deps = (binding.ctor.inject ?? []).map(spec =>
        typeof spec === 'symbol' ? this.get(spec) : this.getAll(spec.multi));
      const instance = new binding.ctor(...(deps as never[]));
      binding.instance = instance;
      if (isDisposable(instance)) {
        this.instantiated.push(instance);
      }
    }
    return binding.instance;
  }

  /** Disposes every service this container instantiated, newest first. */
  public dispose(): void {
    for (const disposable of [...this.instantiated].reverse()) {
      disposable.dispose();
    }
    this.instantiated.length = 0;
  }
}
