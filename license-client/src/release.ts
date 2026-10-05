// Release builds (Phase 10) compile with esbuild `define: { __VPM_RELEASE__: 'true' }`.
// The identifier is replaced by a literal at build time, so nothing at runtime
// (environment, preloaded scripts) can turn development behaviour back on.
declare const __VPM_RELEASE__: boolean | undefined;

export const RELEASE: boolean = typeof __VPM_RELEASE__ !== 'undefined' && __VPM_RELEASE__ === true;
