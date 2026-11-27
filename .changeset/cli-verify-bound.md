---
"@spinajs/cli": patch
---

`spinajs authz:verify -k <k>` refuses a bound that is not a whole number of at least 1 with a usage error; before, `-k 0` or `-k abc` crashed the run with a TypeError.
