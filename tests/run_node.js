/**
 * Node.js 环境确定性规范测试运行器 (供 GitHub Actions CI/CD 与本地 Node 运行)
 */
import { runAllSpecTests } from './core.spec.js';

const results = runAllSpecTests();
let failed = 0;

console.log('==========================================================');
console.log('  《中原逐鹿》SDD 确定性模拟核心规范测试套件 (Node.js)');
console.log('==========================================================');

for (const r of results) {
  console.log(`${r.passed ? '✅ [PASS]' : '❌ [FAIL]'} ${r.name}\n   └─ ${r.detail}`);
  if (!r.passed) failed++;
}

console.log('----------------------------------------------------------');
console.log(`测试汇总: ${results.length - failed}/${results.length} 通过.`);
console.log('==========================================================');

if (failed > 0) {
  process.exit(1);
}
