/**
 * Identifier for the bundle this station is running, stamped by scripts/bundle.mjs at build
 * time. `__WT_CLIENT_BUILD__` is replaced by esbuild; running from source (tsc output, tests)
 * leaves it undefined, which is reported honestly rather than guessed at.
 */
declare const __WT_CLIENT_BUILD__: string | undefined;

export function clientBuild(): string {
  return typeof __WT_CLIENT_BUILD__ === "string" ? __WT_CLIENT_BUILD__ : "source";
}
