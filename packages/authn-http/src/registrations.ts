// Scanned controllers must register what the 2.x rbac-http package index registered;
// importing the package index from inside the package would form an import cycle.
import './dto/auth-responses.js';
import './middlewares.js';
import './route-args.js';
import './transformers.js';
