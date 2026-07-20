/**
 * cli/ui.ts — lo compartido por todos los comandos: colores y el error de USUARIO.
 *
 * {@link CliError} existe para que los comandos NO llamen `process.exit()` por su
 * cuenta: un `exit` enterrado en un parser lo vuelve inverificable (no se puede
 * testear una función que mata el proceso) y se lleva puesto cualquier cleanup.
 * Acá se LANZA, y el único que decide el exit code es el catch de `cli.ts`.
 *
 * La regla: `CliError` = culpa del input (flag mal escrita, JSON roto, archivo que
 * no existe) → mensaje limpio, sin stack. Cualquier otro throw es un bug nuestro
 * → stack completo, que se vea.
 */
export const DIM = '\x1b[2m';
export const CYAN = '\x1b[36m';
export const RED = '\x1b[31m';
export const GREEN = '\x1b[32m';
export const OFF = '\x1b[0m';

/** Error de USO: se le muestra al usuario tal cual, sin stack. */
export class CliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** Corta con un mensaje para el usuario. El tipo `never` deja que TypeScript
 *  entienda que lo que sigue es inalcanzable (sin necesidad de `return`). */
export function fail(message: string): never {
  throw new CliError(message);
}

/**
 * El fallo YA se le explicó al usuario con un diagnóstico completo: el catch de
 * `cli.ts` tiene que salir callado.
 *
 * Sin esto, un fallo de auth imprimía el diagnóstico útil ("renová la sesión:
 * claude login") e INMEDIATAMENTE debajo el stack crudo del SDK, que lo tapaba.
 * Lo último que ve el usuario es lo que cree que importa, y era el ruido.
 */
export class ReportedError extends Error {
  public constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : String(cause ?? 'fallo ya reportado'));
    this.name = 'ReportedError';
  }
}
