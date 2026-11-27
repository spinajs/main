---
"@spinajs/configuration": patch
---

With a `ConfigurationOverlay` registered, `Configuration.get` parses a string path once (up to 10,000 distinct paths) instead of on every read: a read the overlay does not cover costs about what it cost without an overlay.
