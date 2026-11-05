import { runAllSpecTests } from './core.spec.js';

const results = runAllSpecTests();
let failed = 0;
for (const r of results) {
  print(`${r.passed ? '[PASS]' : '[FAIL]'} ${r.name} -> ${r.detail}`);
  if (!r.passed) failed++;
}
print(`\nSummary: ${results.length - failed}/${results.length} passed.`);
if (failed > 0) {
  throw new Error(`${failed} spec tests failed!`);
}
