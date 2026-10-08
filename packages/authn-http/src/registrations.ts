// Scanned controllers must register what the package index registers;
// importing the package index from inside the package would form an import cycle.
import './dto/auth-responses.js';
import './route-args.js';
import './transformers.js';
// The 3.0 authentication layer and, with it, the 2.x request keys bridge.
import './v3/index.js';
