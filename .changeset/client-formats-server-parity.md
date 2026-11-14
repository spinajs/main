---
'@spinajs/client': patch
---

`@spinajs/client/formats` follows the server's comparison and number rules: `ajvEqual` compares an own `valueOf` or `toString` key as data instead of throwing, `ajvUniqueItems` counts repeated `'__proto__'` strings as duplicates, and `ajvCoerce` leaves a value that would coerce to a non-finite number as it is.