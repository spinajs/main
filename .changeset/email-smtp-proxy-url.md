---
"@spinajs/email-smtp-transport": major
---

Breaking: an `options.proxy` with an unencoded `@` in its path or query (`http://proxy.example.com:3128/?via=ops@example.com`), which dialled the proxy before, is now refused at boot: write the `@` as `%40`. It cannot be told apart from a password with an unencoded `/`, `?` or `#`, the same ruling as for `options.url`.

Security fix: `nodemailer` reads a string `options.proxy` with the legacy `url.parse()`. A proxy URL with an unencoded `/`, `?` or `#` in its user name or password (`http://user:pa/ss@proxy.example.com:3128`) made Node print a `DEP0170` deprecation warning with the whole URL, password included, to stderr (Node 24, default warning settings), and made `nodemailer` dial the user name as the proxy host. Now `resolve()` refuses a non-empty `options.proxy` that `new URL()` rejects or that has an `@` after the host with `InvalidArgument('Email smtp connection <name> has an options.proxy that is not a URL: ...')` before `createTransport`, so before any lookup, connection or warning. A well-formed proxy URL (`http:`, `https:`, `socks:`, `socks4:`, `socks4a:`, `socks5:`, percent-encoded credentials, an IPv4 or IPv6 literal) is passed to `nodemailer` unchanged, and a proxy that is not a string is left to `nodemailer`, which ignores it.
