// Compiles the CommonJS bundle to V8 bytecode (the technique of bytenode, MIT).
// Must run on the exact Node.js binary that will execute it: the release
// build uses the same official binary that becomes bin/vpm.
//
//   <target-node> scripts/sea/compile-bytecode.cjs <bundle.cjs> <out.jsc>
'use strict';
const fs = require('node:fs');
const v8 = require('node:v8');
const vm = require('node:vm');
const Module = require('node:module');

// Compile every function eagerly and never flush bytecode: at runtime there is
// no source to recompile from.
v8.setFlagsFromString('--no-lazy');
v8.setFlagsFromString('--no-flush-bytecode');

const [src, out] = process.argv.slice(2);
const code = Module.wrap(fs.readFileSync(src, 'utf8'));
const script = new vm.Script(code, { filename: 'vpm.js' });
const data = script.createCachedData();
fs.writeFileSync(out, data);
// Recorded so the loader can rebuild a placeholder of the same length.
console.log(JSON.stringify({ bytes: data.length, sourceLength: code.length, node: process.version }));
