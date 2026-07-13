/**
 * A map whose keys are compared through a projection function — the standard
 * answer to "I need custom key equality" (e.g. case-insensitive lookups).
 * The ORIGINAL key is preserved for iteration.
 * (Pattern: vscode-js-debug src/common/datastructure/mapUsingProjection.ts,
 * used as `new MapUsingProjection(s => s.toLowerCase())` for URL lookups.)
 */
export class MapUsingProjection<K, V> {
  private readonly map = new Map<unknown, { key: K; value: V }>();

  constructor(
    private readonly projection: (key: K) => unknown,
    entries?: Iterable<readonly [K, V]>,
  ) {
    for (const [key, value] of entries ?? []) {
      this.set(key, value);
    }
  }

  public set(key: K, value: V): this {
    this.map.set(this.projection(key), { key, value });
    return this;
  }

  public get(key: K): V | undefined {
    return this.map.get(this.projection(key))?.value;
  }

  public has(key: K): boolean {
    return this.map.has(this.projection(key));
  }

  public delete(key: K): boolean {
    return this.map.delete(this.projection(key));
  }

  public get size(): number {
    return this.map.size;
  }

  public clear(): void {
    this.map.clear();
  }

  public *values(): IterableIterator<V> {
    for (const entry of this.map.values()) {
      yield entry.value;
    }
  }

  public *entries(): IterableIterator<[K, V]> {
    for (const entry of this.map.values()) {
      yield [entry.key, entry.value];
    }
  }

  public [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }
}
