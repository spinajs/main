import type { LogLevel } from "./index.js";

/**
 * Browser-only runtime log-level persistence ( loglevel-style ). Lets a user's
 * `setLevel(...)` choice survive page reloads via `localStorage`, with a
 * `document.cookie` fallback for environments where storage throws ( eg. Safari
 * private mode ). On Node ( no `window` ) every helper is a clean no-op.
 *
 * Kept dependency-free and free of any `node:*` imports so log-common stays
 * browser-safe: the only globals touched are `window` / `document`, guarded by
 * `typeof` checks.
 */

const KEY_PREFIX = "spinajs:log:level:";

function storageKey(loggerName: string): string {
  return `${KEY_PREFIX}${loggerName}`;
}

/** True only in a browser-like environment with a usable localStorage. */
function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function writeCookie(key: string, value: string): void {
  if (typeof document === "undefined") {
    return;
  }
  try {
    // 1 year, path=/ so the value is visible across the app.
    const maxAge = 60 * 60 * 24 * 365;
    document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)};path=/;max-age=${maxAge}`;
  } catch {
    // nothing else we can do - persistence is best-effort.
  }
}

function readCookie(key: string): string | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  try {
    const enc = encodeURIComponent(key);
    const parts = document.cookie ? document.cookie.split(";") : [];
    for (const part of parts) {
      const [k, ...rest] = part.trim().split("=");
      if (k === enc) {
        return decodeURIComponent(rest.join("="));
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

function expireCookie(key: string): void {
  if (typeof document === "undefined") {
    return;
  }
  try {
    document.cookie = `${encodeURIComponent(key)}=;path=/;max-age=0`;
  } catch {
    // ignore
  }
}

/**
 * Persist `level` for `loggerName`. Browser only - writes `String(level)` to
 * localStorage under `spinajs:log:level:<loggerName>`, falling back to a cookie
 * when storage throws. No-op on Node.
 */
export function persistLevel(loggerName: string, level: LogLevel): void {
  if (!hasWindow()) {
    return;
  }

  const key = storageKey(loggerName);
  const value = String(level);

  try {
    // window.localStorage access itself can throw ( disabled cookies / private mode ).
    if (window.localStorage) {
      window.localStorage.setItem(key, value);
      return;
    }
  } catch {
    // fall through to the cookie fallback below.
  }

  writeCookie(key, value);
}

/**
 * Read back the persisted level for `loggerName` ( localStorage then cookie ).
 * Returns a finite {@link LogLevel} number, or `undefined` when nothing valid is
 * stored. Always `undefined` on Node.
 */
export function readPersistedLevel(loggerName: string): LogLevel | undefined {
  if (!hasWindow()) {
    return undefined;
  }

  const key = storageKey(loggerName);
  let raw: string | null | undefined;

  try {
    if (window.localStorage) {
      raw = window.localStorage.getItem(key);
    }
  } catch {
    raw = undefined;
  }

  if (raw === null || raw === undefined) {
    raw = readCookie(key);
  }

  if (raw === null || raw === undefined || raw === "") {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? (parsed as LogLevel) : undefined;
}

/**
 * Remove any persisted level for `loggerName` ( localStorage + cookie ). No-op
 * on Node.
 */
export function clearPersistedLevel(loggerName: string): void {
  if (!hasWindow()) {
    return;
  }

  const key = storageKey(loggerName);

  try {
    if (window.localStorage) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore - fall through to also expire the cookie.
  }

  expireCookie(key);
}
