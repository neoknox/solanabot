import { ArbitrageScanner } from '../src/scanner/arbitrageScanner';
import { loadConfig } from '../src/config';

async function main() {
  const memBefore = process.memoryUsage();
  console.log('Memory before scanner init:');
  console.log(`  RSS:       ${(memBefore.rss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  HeapUsed:  ${(memBefore.heapUsed / 1024 / 1024).toFixed(1)} MB`);

  const config = loadConfig();
  const scanner = new ArbitrageScanner(config);

  const memAfterInit = process.memoryUsage();
  console.log('\nMemory after scanner construction (SQLite & RouteIndex loaded):');
  console.log(`  RSS:       ${(memAfterInit.rss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  HeapUsed:  ${(memAfterInit.heapUsed / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Routes:    ${scanner.getRouteIndex().getRouteCount()}`);

  scanner.stop();
}

main().catch(console.error);
