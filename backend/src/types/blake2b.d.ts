// Minimal ambient declarations for the `blake2b` npm package, which ships no types.
// Pulled from the package README / index.js. Only the surface we use is declared.

declare module 'blake2b' {
  interface Blake2b {
    update(input: Uint8Array | Buffer): Blake2b;
    digest(out?: Uint8Array | Buffer): Uint8Array;
  }
  // blake2b(outLen: number, key?, salt?, personal?, noAssert?): Blake2b
  // Full signature in the README, but only outLen is required for our use.
  function blake2b(outLen: number): Blake2b;
  export = blake2b;
}
