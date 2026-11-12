import { config } from '../config/index.js';
import { ArbitrageScanner } from '../scanner/arbitrageScanner.js';

async function main() {
  console.log('================================================================');
  console.log('  SOLANA ARBITRAGE BOT - LIVE MAINNET SMOKE TEST (PHASE 1.1)    ');
  console.log('  PERFORMANCE & LATENCY HARDENING ADDENDUM                     ');
  console.log('  (Strictly Read-Only: No Private Keys, No Execution, No Funds) ');
  console.log('================================================================');
  console.log(`Connecting to Solana RPC: ${config.SOLANA_RPC_HTTP}`);
  console.log(`Connecting to Solana WS:  ${config.SOLANA_RPC_WS}`);
  console.log(`WebSocket Commitment:     ${config.WS_COMMITMENT || 'processed'}\n`);

  const cpuStart = process.cpuUsage();
  const startTimeMs = performance.now();

  const scanner = new ArbitrageScanner(config);

  scanner.onCandidate((c) => {
    const time = new Date(c.timestamp).toISOString();
    const inputUSD = (Number(c.inputAmountUSDC) / 1e6).toFixed(2);
    const out1WSOL = (Number(c.leg1ExpectedOutWSOL) / 1e9).toFixed(5);
    const out2USD = (Number(c.leg2ExpectedOutUSDC) / 1e6).toFixed(2);
    console.log(`[CANDIDATE ${c.status}] ${time} ${c.routeName}`);
    console.log(`  Size: $${inputUSD} -> Leg1: ${out1WSOL} WSOL -> Leg2: $${out2USD} USDC`);
    console.log(`  Expected Net: $${c.expectedNetUSDC} | Conservative Net: $${c.minConservativeNetUSDC}`);
    if (c.rejectionReasons.length > 0) {
      console.log(`  Rejection Reasons: ${c.rejectionReasons.join(', ')}`);
    }
    console.log('');
  });

  await scanner.start();

  console.log('Running event-driven scan against Solana mainnet for 25 seconds...\n');
  await new Promise(resolve => setTimeout(resolve, 25000));

  const totalRunTimeMs = performance.now() - startTimeMs;
  const cpuEnd = process.cpuUsage(cpuStart);
  const memUsage = process.memoryUsage();

  const health = scanner.getHealthStatus();
  const audit = scanner.getAuditMetrics();
  const latency = scanner.getLatencyReport();
  const queueStats = scanner.getEventQueueStats();
  const routeCount = scanner.getRouteIndex().getRouteCount();

  scanner.getRepository().recordAuditMetrics(audit);

  console.log('================================================================');
  console.log('  MAINNET SMOKE TEST & LATENCY BENCHMARK COMPLETED              ');
  console.log('================================================================');
  console.log(`Final Solana Slot:              ${health.currentSlot}`);
  console.log(`WebSocket Feed Status:          ${health.connectedWs ? 'CONNECTED' : 'DISCONNECTED'}`);
  console.log(`Active Monitored Pools:         ${health.activePoolCount}`);
  console.log(`Indexed Directed Routes:        ${routeCount}`);
  console.log(`Total Routes Evaluated:         ${audit.totalEvaluated}`);
  console.log(`Unique Opportunities:           ${audit.uniqueOpportunities}`);
  console.log(`Gross-Positive Candidates:      ${audit.candidatesGrossPositive}`);
  console.log(`Conservative Net Qualified:     ${audit.candidatesConservativeQualified}`);
  console.log(`Rejected Routes:                ${audit.rejectedRoutes}`);
  console.log(`Quote Validation Failures:      ${audit.quoteValidationFailures}`);
  console.log(`Rejection Reasons Breakdown:    ${JSON.stringify(health.rejectionBreakdown, null, 2)}`);

  console.log('\n--- LATENCY INSTRUMENTATION BENCHMARKS ---');
  const fmtUs = (stats: typeof latency.detectionToDecisionUs) =>
    `p50: ${(stats.p50).toFixed(1)}μs | p95: ${(stats.p95).toFixed(1)}μs | p99: ${(stats.p99).toFixed(1)}μs | max: ${(stats.max).toFixed(1)}μs | mean: ${(stats.mean).toFixed(1)}μs (n=${stats.count})`;
  
  console.log(`Detection-to-Decision Latency:  ${fmtUs(latency.detectionToDecisionUs)}`);
  console.log(`Quote Calculation Latency:      ${fmtUs(latency.quoteLatencyUs)}`);
  console.log(`Pool State Decoding Latency:    ${fmtUs(latency.decodeLatencyUs)}`);
  console.log(`Profit Validation Latency:      ${fmtUs(latency.validationLatencyUs)}`);
  console.log(`RPC Batch Fetch Latency:        p50: ${latency.rpcLatencyMs.p50.toFixed(1)}ms | p95: ${latency.rpcLatencyMs.p95.toFixed(1)}ms | max: ${latency.rpcLatencyMs.max.toFixed(1)}ms`);
  console.log(`Observed Slot Lag:              ${latency.lastSlotLag} slots`);
  console.log(`Event Loop Delay:               ${latency.eventLoopDelayMs.toFixed(2)} ms`);

  console.log('\n--- EVENT QUEUE & COALESCING STATS ---');
  console.log(`Processed Account Updates:      ${queueStats.processedCount}`);
  console.log(`Coalesced Superseded Updates:   ${queueStats.coalescedCount}`);
  console.log(`Backpressure Dropped Updates:   ${queueStats.droppedCount}`);
  console.log(`Peak Queue Size:                ${queueStats.peakQueueSize}`);

  console.log('\n--- RESOURCE UTILIZATION ---');
  const userCpuSec = (cpuEnd.user / 1e6).toFixed(2);
  const sysCpuSec = (cpuEnd.system / 1e6).toFixed(2);
  const totalCpuSec = ((cpuEnd.user + cpuEnd.system) / 1e6).toFixed(2);
  const cpuPercent = (((cpuEnd.user + cpuEnd.system) / 1e3) / totalRunTimeMs * 100).toFixed(1);
  const rssMb = (memUsage.rss / 1024 / 1024).toFixed(1);
  const heapUsedMb = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
  console.log(`CPU Time Consumed:              ${totalCpuSec}s (User: ${userCpuSec}s, Sys: ${sysCpuSec}s, Avg CPU: ${cpuPercent}%)`);
  console.log(`Memory RSS:                     ${rssMb} MB (Heap Used: ${heapUsedMb} MB)`);
  console.log('================================================================\n');

  scanner.stop();
  process.exit(0);
}

main().catch(err => {
  console.error('Smoke test error:', err);
  process.exit(1);
});
