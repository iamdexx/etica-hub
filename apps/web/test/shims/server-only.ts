// Empty shim for Next's `server-only` marker so vitest can import
// modules that declare themselves server-only. Next ships a build-time
// error module under this name; in unit tests we don't need that
// guard because the modules never reach the client bundle.
export {};
