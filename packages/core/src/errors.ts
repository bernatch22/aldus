/**
 * User-facing errors are structured DATA, not strings: a code, a format
 * message, and a visibility flag. Named factories per domain error (llegan
 * con cada dominio en F2-F7); one ProtocolError wrapper carries the structure
 * through `throw` to the ONE catch site (server middleware / runTool).
 * (Pattern: vscode-js-debug src/dap/errors.ts + src/dap/protocolError.ts)
 *
 * Contract subtleties:
 *  - `showUser: true` → the message is safe and useful for an end user;
 *    false → log/telemetry only (never leak pdf-lib internals to the UI).
 *  - Codes are stable API: consumers assert on `code`, never on `format`.
 */
export interface StructuredError {
  readonly __errorMarker: true;
  readonly code: number;
  readonly format: string;
  /** true → show to the user; false → log/telemetry only. */
  readonly showUser: boolean;
}

const createError = (code: number, format: string, showUser: boolean): StructuredError => ({
  __errorMarker: true,
  code,
  format,
  showUser,
});

export const createUserError = (format: string, code: number): StructuredError =>
  createError(code, format, true);

export const createSilentError = (format: string, code: number): StructuredError =>
  createError(code, format, false);

export const isStructuredError = (value: unknown): value is StructuredError =>
  typeof value === 'object'
  && value !== null
  && (value as StructuredError).__errorMarker === true;

/** The throwable wrapper: carries the StructuredError through `throw`. */
export class ProtocolError extends Error {
  constructor(public readonly error: StructuredError) {
    super(error.format);
    this.name = 'ProtocolError';
  }
}
