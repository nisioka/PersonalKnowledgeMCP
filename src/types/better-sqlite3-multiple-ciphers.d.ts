// `better-sqlite3-multiple-ciphers` is an API-compatible drop-in for
// `better-sqlite3` (same native binding plus SQLCipher/encryption support), so
// it shares the upstream type definitions. This ambient declaration re-exports
// them under the package name we actually import at runtime.
declare module "better-sqlite3-multiple-ciphers" {
  import Database = require("better-sqlite3");
  export = Database;
}
