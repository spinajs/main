---
"@spinajs/email-smtp-transport": patch
---

Security fix: `nodemailer` reads `options.url` and `options.proxy` with the legacy `url.parse()`, which reads a `\` in the user name or password as `/` and takes the user name for the host, where `new URL()` keeps it in the userinfo of an `smtp:`, `smtps:`, `socks:` or registered scheme. Such a url or proxy made `nodemailer` look the user name up and Node print a `DEP0170` warning with the whole URL, password included, to stderr. `resolve()` now refuses a `\` before the last `@` with `InvalidArgument`, before any lookup, connection or warning: write it `%5C`. A `url` in the query of `options.url` (`?url=`), which `nodemailer`'s SMTP transport parses again and dials, is checked the same way. The refusal messages now name `\` and `%5C`. Patch, not major: every refused form made `nodemailer` dial the user name, so none of them connected before.
