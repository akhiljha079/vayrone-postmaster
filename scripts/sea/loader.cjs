// SEA entry of bin/vpm: runs the V8 bytecode embedded as asset "vpm.jsc".
// The real source is not in the executable; V8 gets a placeholder string of
// the original length and executes the precompiled bytecode.
'use strict';
const v8 = require('node:v8');
const vm = require('node:vm');
const path = require('node:path');
const { getAsset } = require('node:sea');

v8.setFlagsFromString('--no-lazy');
v8.setFlagsFromString('--no-flush-bytecode');

const bytecode = Buffer.from(getAsset('vpm.jsc'));
// V8 checks a hash of its flags; take it from a script compiled right now with the same flags.
const probe = new vm.Script('"ಠ_ಠ"').createCachedData();
probe.subarray(12, 20).copy(bytecode, 12);
const length = bytecode.readUInt32LE(8) & 0x7fffffff;
const placeholder = `"${'​'.repeat(Math.max(0, length - 2))}"`;
const script = new vm.Script(placeholder, { filename: 'vpm.js', cachedData: bytecode });
if (script.cachedDataRejected) {
  console.error('vpm: this program file is damaged or was built for another platform. Reinstall Vayrone PostMaster.');
  process.exit(70);
}
const filename = path.join(path.dirname(process.execPath), 'vpm.js');
const mod = { exports: {}, filename, id: '.', loaded: false };
script.runInThisContext()(mod.exports, require, mod, filename, path.dirname(filename));
