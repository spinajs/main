---
'@spinajs/testing': patch
---

`createTestApp` claims the root slot before the boot starts. New `bootTimeout` option abandons a stuck root boot (default 30000 ms): root is restored, the slot freed, and the late boot is a no-op. A root create while another root app is booting or being disposed now fails fast, naming it (`name` option).
