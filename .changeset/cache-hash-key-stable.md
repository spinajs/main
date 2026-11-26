---
"@spinajs/cache": minor
---

`hashKey` gives equal parts one key. It hashed the `node:v8` bytes of the parts, which depend on how V8 holds a string: an equal string cut from text with a character above U+00FF (`split`, `replace`, `slice`), `-0` against `0`, or the same object with its keys in another order hashed apart, so a `delete` by such a key missed the entry and stale reads went on. It now hashes a type-tagged text: strings by value, object keys, `Map` entries and `Set` items in any order, `-0` as `0`, a property that holds `undefined` as a missing one.

**Every key `hashKey` produces changes**, ASCII ones too: an entry stored under an old key is a miss once after the upgrade. A class instance (a `RegExp`, an `Error` and a boxed primitive among them) and a cyclic object, which were hashed before, are refused with `InvalidArgument`, which names the part: two classes with the same fields shared a key. A function and a symbol stay refused; a `Date`, a `Map`, a `Set` and a `Buffer` or other typed array stay keys.
