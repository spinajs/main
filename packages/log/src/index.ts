/**
 * We export default configuration for webpack modules
 * Normally we load configuration from disk via filesystem
 * But webpack is bundlig all files into one.
 *
 * When we export, we can see configuration variable
 * in webpack module cache and webpack config loader can see it
 */
export * as config from "./config/log";

/**
 * Same issue with schemas
 */
export * as CONFIGURATION_SCHEMA from "./schemas/log.configuration";

export * from "@spinajs/log-common";
export * from "./targets";
export * from "./variables";
export * from "./log";
export * from "./decorators";
