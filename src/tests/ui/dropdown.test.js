'use strict';
// Run the in-page picker regressions in the standard UI gate as well as their focused runner.
// Their DOM adapter also provides MutationObserver and geometry for dropdown positioning.
const { test } = require('./harness');
const cases = require('../../../tools/dev/dropdown_unit_test');

for (const { name, run } of cases) test(`dropdown: ${name}`, run);
