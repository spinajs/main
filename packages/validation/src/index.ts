/**
 * We export default configuration for webpack modules
 * Normally we load configuration from disk via filesystem
 * But webpack is bundlig all files into one.
 * 
 * When we export, we can see configuration variable
 * in webpack module cache and webpack config loader can see it 
 */
export * from "./config/validation";
export * from "./decorators";
export * from "./exceptions";
export * from "./sources";
export * from "./validator";