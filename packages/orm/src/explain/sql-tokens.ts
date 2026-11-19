// Its own module so the explain modules share it without it reaching the package index.

/** A single-, double- or backtick-quoted token, a doubled quote character escaping itself. */
export const QUOTED = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`/;
