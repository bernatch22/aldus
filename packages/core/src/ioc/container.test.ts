import { describe, expect, it } from 'vitest';
import type { IDisposable } from '../common/disposable.js';
import { all, Container, createToken } from './container.js';

interface IGreeter {
  greet(): string;
}
const IGreeter = createToken<IGreeter>('IGreeter');

class EnglishGreeter implements IGreeter {
  public greet() {
    return 'hello';
  }
}
class SpanishGreeter implements IGreeter {
  public greet() {
    return 'hola';
  }
}

describe('Container', () => {
  it('resolves class bindings as per-container singletons', () => {
    const container = new Container();
    container.bind(IGreeter).to(EnglishGreeter);
    const a = container.get(IGreeter);
    expect(a.greet()).toBe('hello');
    expect(container.get(IGreeter)).toBe(a);
  });

  it('resolves constants and throws a clear error for missing bindings', () => {
    const container = new Container();
    container.bind(IGreeter).toConstantValue({ greet: () => 'yo' });
    expect(container.get(IGreeter).greet()).toBe('yo');
    expect(() => container.get(createToken<IGreeter>('IMissing'))).toThrow(/No binding/);
  });

  it('multi-binding: getAll returns every implementation, parent-first', () => {
    const parent = new Container();
    parent.bind(IGreeter).to(EnglishGreeter);
    const child = parent.createChild();
    child.bind(IGreeter).to(SpanishGreeter);
    expect(child.getAll(IGreeter).map(g => g.greet())).toEqual(['hello', 'hola']);
    // single get() prefers the child's own (last) binding — override semantics
    expect(child.get(IGreeter).greet()).toBe('hola');
    // the parent is untouched by the child's bindings
    expect(parent.getAll(IGreeter)).toHaveLength(1);
  });

  it('injects constructor deps from the static inject tuple, including all()', () => {
    interface IAnnouncer {
      announce(): string;
    }
    const IAnnouncer = createToken<IAnnouncer>('IAnnouncer');
    class Announcer implements IAnnouncer {
      public static readonly inject = [all(IGreeter)] as const;
      constructor(private readonly greeters: readonly IGreeter[]) {}
      public announce() {
        return this.greeters.map(g => g.greet()).join(' ');
      }
    }
    const container = new Container();
    container.bind(IGreeter).to(EnglishGreeter);
    container.bind(IGreeter).to(SpanishGreeter);
    container.bind(IAnnouncer).to(Announcer);
    expect(container.get(IAnnouncer).announce()).toBe('hello hola');
  });

  it('dispose() tears down every instantiated disposable, newest first', () => {
    const order: string[] = [];
    class First implements IDisposable {
      public dispose() {
        order.push('first');
      }
    }
    class Second implements IDisposable {
      public dispose() {
        order.push('second');
      }
    }
    const IFirst = createToken<First>('IFirst');
    const ISecond = createToken<Second>('ISecond');
    const container = new Container();
    container.bind(IFirst).to(First);
    container.bind(ISecond).to(Second);
    container.get(IFirst);
    container.get(ISecond);
    container.dispose();
    expect(order).toEqual(['second', 'first']);
  });
});
