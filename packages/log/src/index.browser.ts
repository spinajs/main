/**
 * Browser entry ( "browser" exports condition ).
 *
 * Reuses the platform-free FrameworkLogger + DI factory registrations from
 * log.js verbatim; swaps ColoredConsoleTarget ( chalk ) for BrowserConsoleTarget
 * and omits FileTarget ( fs/zlib/stream ) and bootstrap.js ( process handlers ).
 *
 * Importing this module transitively imports @spinajs/configuration, which on
 * the browser condition registers BrowserFrameworkConfiguration — so a single
 * side-effect `import "@spinajs/log"` wires both log and configuration.
 */
export * from "@spinajs/log-common";
export * from "./targets/BlackHoleTarget.js";
export * from "./targets/BrowserConsoleTarget.js";
export * from "./targets/MemoryTarget.js";
export * from "./log.js";
