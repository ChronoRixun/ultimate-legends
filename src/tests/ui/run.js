'use strict';
// The launcher UI's unit tests: node src/tests/ui/run.js (the build workflow runs it after the C++
// tests). Each *.test.js in this folder registers its tests with harness.test(name, fn); a test
// fails on any thrown error. Prints like the C++ runner and exits 1 when a test failed.

const fs = require('fs');
const path = require('path');
const { tests } = require('./harness');

(async () => {
    for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js')).sort()) {
        require(path.join(__dirname, file));
    }
    let failed = 0;
    for (const { name, run } of tests) {
        try {
            await run();
            console.log(`  ok    ${name}`);
        } catch (error) {
            failed++;
            console.log(`  FAIL  ${name}`);
            console.log(String((error && error.stack) || error).split('\n').map(line => `        ${line}`).join('\n'));
        }
    }
    console.log(`${tests.length} tests, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
