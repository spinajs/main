---
"@spinajs/cli": patch
---

`spinajs authz:verify -k <k>` takes a whole number from 1 to 64 and refuses anything else with a usage error. Before, `-k 0` or `-k abc` crashed the run with a TypeError, `-k 4294967296` with a RangeError, and `-k 5000000` ran out of memory. `-k 1.5` and `-k 2abc`, which were truncated to 1 and 2, are refused too, as are other values that are not plain digits (`1e3`, `0x10`, `010`). A pipeline that passed a bound above 64 must pass 64 or less.
