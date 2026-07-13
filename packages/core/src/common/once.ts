/**
 * Memoize a thunk: expensive work runs at most once, reads become pure.
 * (Pattern: vscode-js-debug src/common/objUtils.ts `once` — used to defer
 * expensive entity work, e.g. StackFrame.uiLocation().)
 *
 * Subtlety: the thunk is retained after the first call only through the
 * captured `value`; a thrown first call is NOT memoized and will re-run.
 */
export const once = <T>(fn: () => T): (() => T) => {
  let called = false;
  let value: T;
  return () => {
    if (!called) {
      value = fn();
      called = true;
    }
    return value;
  };
};
