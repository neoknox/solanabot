import fs from 'fs';
import path from 'path';
import { ArbitrageScanner } from '../scanner/arbitrageScanner.js';
import { loadConfig } from '../config/index.js';

export interface SecondSample {
  timestamp: string;
  timestampMs: number;
  elapsedSeconds: number;
  storedRoutes: number;
  uniqueRoutes: number;
  restoredRoutes: number;
  verifiedRoutes: number;
  readyRoutes: number;
  staleRoutes: number;
  blockedRoutes: number;
  clmmActivatedPools: number;
  quoteValidEvaluations: number;
  totalEvaluated: number;
  quotesPerSecond: number;
  rejectionBreakdown: Record<string, number>;
  quoteLatencyP50Us: number;
  quoteLatencyP95Us: number;
  quoteLatencyP99Us: number;
  rpcLatencyMs: number;
  rssMb: number;
  heapUsedMb: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rpcRequestsTotal: number;
  rpcRequestsFailed: number;
  wsMessagesTotal: number;
  wsSubscriptionsCount: number;
  queueDepth: number;
  queueDrops: number;
  persistenceErrors: number;
}

export interface CheckpointRecord {
  type: 'VERIFIED_ROUTES' | 'SIMULTANEOUS_READY_ROUTES';
  target: number;
  reached: boolean;
  reachedAtSecond?: number;
  reachedAtTimestamp?: string;
}

export interface Phase16BenchmarkResult {
  metadata: {
    title: string;
    description: string;
    startedAt: string;
    completedAt: string;
    durationSeconds: number;
    mode: 'READ_ONLY_MAINNET';
  };
  checkpoints: {
    verifiedRoutes: Record<string, CheckpointRecord>;
    readyRoutes: Record<string, CheckpointRecord>;
  };
  summary: {
    peakReady: number;
    minReady: number;
    averageReady: number;
    p10ReadyCount: number;
    readyUptimePercent: number;
    totalConfiguredRoutes: number;
    uniqueRoutesCount: number;
    restoredRoutesCount: number;
    verifiedRoutesTotal: number;
    clmmActivatedPoolsTotal: number;
    totalPoolsInUniverse: number;
    totalQuotesGenerated: number;
    quoteValidEvaluations: number;
    validQuotePercentage: number;
    averageQuoteLatencyUs: number;
    quoteLatencyP95Us: number;
    averageRpcLatencyMs: number;
    totalRpcRequests: number;
    totalWsMessages: number;
    queueDropsTotal: number;
    persistenceErrorsTotal: number;
    peakMemoryRssMb: number;
    rejectionBreakdownSummary: Record<string, number>;
  };
  samples: SecondSample[];
}

export async function runMainnet10MinBenchmark(durationSeconds: number = 600): Promise<Phase16BenchmarkResult> {
  console.log('\n================================================================');
  console.log('   SOLANABOT — PHASE 1.6 COVERAGE GATE VERIFICATION');
  console.log(`   10-Minute Continuous Read-Only Mainnet Benchmark (${durationSeconds}s)`);
  console.log('================================================================\n');

  const projectRoot = process.cwd();
  const dbPath = path.join(projectRoot, 'data/arbitrage.db');
  const discoveredFile = path.join(projectRoot, 'data/discovered_pools.json');
  const config = loadConfig({ DB_PATH: dbPath, DISCOVERED_POOLS_FILE: discoveredFile });

  const scanner = new ArbitrageScanner(config);
  console.log('[MainnetBenchmark] Starting scanner on Solana mainnet-beta...');
  await scanner.start();

  console.log('[MainnetBenchmark] Hydrating on-chain pools and CLMM tick arrays...');
  await scanner.refreshAllPoolStates();

  const routeIndex = scanner.getRouteIndex();
  const poolReg = scanner.getPoolRegistry();
  const repo = scanner.getRepository();

  const startMs = Date.now();
  const startTimeIso = new Date(startMs).toISOString();
  let prevCpu = process.cpuUsage();
  let prevEvaluated = 0;
  let nextLogSecond = 10;

  const verifiedCheckpoints: Record<number, CheckpointRecord> = {
    250: { type: 'VERIFIED_ROUTES', target: 250, reached: false },
    500: { type: 'VERIFIED_ROUTES', target: 500, reached: false },
    1000: { type: 'VERIFIED_ROUTES', target: 1000, reached: false }
  };

  const readyCheckpoints: Record<number, CheckpointRecord> = {
    100: { type: 'SIMULTANEOUS_READY_ROUTES', target: 100, reached: false },
    250: { type: 'SIMULTANEOUS_READY_ROUTES', target: 250, reached: false },
    500: { type: 'SIMULTANEOUS_READY_ROUTES', target: 500, reached: false },
    1000: { type: 'SIMULTANEOUS_READY_ROUTES', target: 1000, reached: false }
  };

  const samples: SecondSample[] = [];

  const interval = setInterval(() => {
    const nowMs = Date.now();
    const elapsedSeconds = Math.floor((nowMs - startMs) / 1000);
    const nowIso = new Date(nowMs).toISOString();

    // 1. Record READY sample in time-weighted rolling tracker
    const currentReady = routeIndex.recordReadySample();

    // 2. Query route states and counts
    const storedRoutes = repo.getAllRoutes().length;
    const uniqueRoutes = routeIndex.getUniqueRouteCount();
    const restoredRoutes = routeIndex.getRestoredRouteCount();
    const verifiedRoutes = routeIndex.getVerifiedRouteCount();
    const readyRoutes = currentReady;
    const staleRoutes = routeIndex.getStaleRouteCount();
    const blockedRoutes = routeIndex.getBlockedRouteCount();

    // 3. Newly activated CLMM pools
    const clmmActivatedPools = poolReg.getAllPools().filter(
      p => p.dex === 'RAYDIUM_CLMM' && p.verificationStatus === 'VERIFIED_DIRECT'
    ).length;

    // 4. Quote and evaluation metrics
    const auditMetrics = scanner.getAuditMetrics();
    const quoteValidEvaluations = auditMetrics.quoteValidRouteCount || 0;
    const totalEvaluated = auditMetrics.totalEvaluated || 0;
    const quotesPerSecond = Math.max(0, totalEvaluated - prevEvaluated);
    prevEvaluated = totalEvaluated;

    // 5. Rejection breakdown
    const rejectionBreakdown = scanner.getBottleneckBreakdown();

    // 6. Latency telemetry
    const latency = scanner.getLatencyReport();

    // 7. Resource telemetry
    const mem = process.memoryUsage();
    const cpuDelta = process.cpuUsage(prevCpu);
    prevCpu = process.cpuUsage();

    // 8. Network and queue telemetry
    const rpcStats = scanner.getRpc().getStats();
    const wsStats = scanner.getWs().getStats();
    const queueStats = scanner.getEventQueueStats();
    const persistenceErrors = repo.getPersistenceErrorsCount();

    const sample: SecondSample = {
      timestamp: nowIso,
      timestampMs: nowMs,
      elapsedSeconds,
      storedRoutes,
      uniqueRoutes,
      restoredRoutes,
      verifiedRoutes,
      readyRoutes,
      staleRoutes,
      blockedRoutes,
      clmmActivatedPools,
      quoteValidEvaluations,
      totalEvaluated,
      quotesPerSecond,
      rejectionBreakdown: { ...rejectionBreakdown },
      quoteLatencyP50Us: latency.quoteLatencyUs?.p50 || 0,
      quoteLatencyP95Us: latency.quoteLatencyUs?.p95 || 0,
      quoteLatencyP99Us: latency.quoteLatencyUs?.p99 || 0,
      rpcLatencyMs: latency.rpcLatencyMs?.p50 || 0,
      rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
      heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
      cpuUserMs: Math.round(cpuDelta.user / 1000),
      cpuSystemMs: Math.round(cpuDelta.system / 1000),
      rpcRequestsTotal: rpcStats.requestsTotal,
      rpcRequestsFailed: rpcStats.requestsFailed,
      wsMessagesTotal: wsStats.messagesTotal || 0,
      wsSubscriptionsCount: wsStats.subscriptionCount,
      queueDepth: queueStats.queuedCount,
      queueDrops: queueStats.droppedCount,
      persistenceErrors
    };

    samples.push(sample);

    // Track Checkpoints
    for (const [targetStr, record] of Object.entries(verifiedCheckpoints)) {
      const target = Number(targetStr);
      if (!record.reached && verifiedRoutes >= target) {
        record.reached = true;
        record.reachedAtSecond = elapsedSeconds;
        record.reachedAtTimestamp = nowIso;
        console.log(`>>> [CHECKPOINT REACHED] Verified Routes Milestone: ${target} routes at T+${elapsedSeconds}s <<<`);
      }
    }

    for (const [targetStr, record] of Object.entries(readyCheckpoints)) {
      const target = Number(targetStr);
      if (!record.reached && readyRoutes >= target) {
        record.reached = true;
        record.reachedAtSecond = elapsedSeconds;
        record.reachedAtTimestamp = nowIso;
        console.log(`>>> [CHECKPOINT REACHED] Simultaneous READY Routes Milestone: ${target} routes at T+${elapsedSeconds}s <<<`);
      }
    }

    // Periodic logging
    if (elapsedSeconds >= nextLogSecond) {
      const readySummary = routeIndex.getReadyMetricsSummary();
      console.log(
        `[T+${elapsedSeconds}s] READY: ${readyRoutes} (Peak: ${readySummary.peakReady}, Avg: ${readySummary.timeWeightedReadyAvg.toFixed(1)}, p10: ${readySummary.p10ReadyCount}) | ` +
        `VERIFIED: ${verifiedRoutes} | STALE: ${staleRoutes} | BLOCKED: ${blockedRoutes} | ` +
        `CLMM Active: ${clmmActivatedPools} | QPS: ${quotesPerSecond} | WS Msgs: ${sample.wsMessagesTotal} | ` +
        `Queue: ${sample.queueDepth} | Mem: ${sample.rssMb} MB`
      );
      nextLogSecond += 10;
    }
  }, 1000);

  // Await completion of observation duration
  await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000));
  clearInterval(interval);

  const stopMs = Date.now();
  const completedTimeIso = new Date(stopMs).toISOString();
  const totalSessionMs = stopMs - startMs;

  console.log('[MainnetBenchmark] Observation completed. Stopping scanner...');
  scanner.stop();

  // Compute summary metrics
  const readySummary = routeIndex.getReadyMetricsSummary();
  const uptimeReport = scanner.getRouteUptimeReport(totalSessionMs);
  const finalAudit = scanner.getAuditMetrics();
  const finalLatency = scanner.getLatencyReport();
  const finalRejection = scanner.getBottleneckBreakdown();
  const peakMemRss = Math.max(...samples.map(s => s.rssMb), 0);
  const totalEvaluatedFinal = finalAudit.totalEvaluated || 0;
  const quoteValidFinal = finalAudit.quoteValidRouteCount || 0;

  const result: Phase16BenchmarkResult = {
    metadata: {
      title: 'SolanaBot Phase 1.6 Coverage Gate 10-Minute Mainnet Benchmark',
      description: 'Continuous 10-minute read-only observation with Raydium CLMM and Orca Whirlpool hydration',
      startedAt: startTimeIso,
      completedAt: completedTimeIso,
      durationSeconds,
      mode: 'READ_ONLY_MAINNET'
    },
    checkpoints: {
      verifiedRoutes: {
        '250': verifiedCheckpoints[250],
        '500': verifiedCheckpoints[500],
        '1000': verifiedCheckpoints[1000]
      },
      readyRoutes: {
        '100': readyCheckpoints[100],
        '250': readyCheckpoints[250],
        '500': readyCheckpoints[500],
        '1000': readyCheckpoints[1000]
      }
    },
    summary: {
      peakReady: readySummary.peakReady,
      minReady: readySummary.minReady,
      averageReady: Number(readySummary.timeWeightedReadyAvg.toFixed(2)),
      p10ReadyCount: readySummary.p10ReadyCount,
      readyUptimePercent: Number(uptimeReport.averageUptimePercent.toFixed(2)),
      totalConfiguredRoutes: routeIndex.getRouteCount(),
      uniqueRoutesCount: routeIndex.getUniqueRouteCount(),
      restoredRoutesCount: routeIndex.getRestoredRouteCount(),
      verifiedRoutesTotal: routeIndex.getVerifiedRouteCount(),
      clmmActivatedPoolsTotal: poolReg.getAllPools().filter(p => p.dex === 'RAYDIUM_CLMM' && p.verificationStatus === 'VERIFIED_DIRECT').length,
      totalPoolsInUniverse: poolReg.getAllPools().length,
      totalQuotesGenerated: totalEvaluatedFinal,
      quoteValidEvaluations: quoteValidFinal,
      validQuotePercentage: totalEvaluatedFinal > 0 ? Number(((quoteValidFinal / totalEvaluatedFinal) * 100).toFixed(2)) : 0,
      averageQuoteLatencyUs: Number((finalLatency.quoteLatencyUs?.p50 || 0).toFixed(1)),
      quoteLatencyP95Us: Number((finalLatency.quoteLatencyUs?.p95 || 0).toFixed(1)),
      averageRpcLatencyMs: Number((finalLatency.rpcLatencyMs?.p50 || 0).toFixed(1)),
      totalRpcRequests: scanner.getRpc().getStats().requestsTotal,
      totalWsMessages: scanner.getWs().getStats().messagesTotal || 0,
      queueDropsTotal: scanner.getEventQueueStats().droppedCount,
      persistenceErrorsTotal: repo.getPersistenceErrorsCount(),
      peakMemoryRssMb: peakMemRss,
      rejectionBreakdownSummary: { ...finalRejection }
    },
    samples
  };

  console.log('\n================================================================');
  console.log('   PHASE 1.6 BENCHMARK EMPIRICAL REPORT SUMMARY');
  console.log('================================================================');
  console.log(`  Duration:                 ${durationSeconds} seconds (10 minutes)`);
  console.log(`  Total Pools in Registry:  ${result.summary.totalPoolsInUniverse}`);
  console.log(`  Active CLMM Pools:        ${result.summary.clmmActivatedPoolsTotal}`);
  console.log(`  Total Configured Routes:  ${result.summary.totalConfiguredRoutes}`);
  console.log(`  Unique Stored Routes:     ${result.summary.uniqueRoutesCount}`);
  console.log(`  Restored Routes:          ${result.summary.restoredRoutesCount}`);
  console.log(`  Structurally Verified:    ${result.summary.verifiedRoutesTotal}`);
  console.log('----------------------------------------------------------------');
  console.log(`  Peak READY Routes:        ${result.summary.peakReady}`);
  console.log(`  Min READY Routes:         ${result.summary.minReady}`);
  console.log(`  Average READY Routes:     ${result.summary.averageReady}`);
  console.log(`  p10 READY Routes:         ${result.summary.p10ReadyCount}`);
  console.log(`  READY Route Uptime:       ${result.summary.readyUptimePercent}%`);
  console.log('----------------------------------------------------------------');
  console.log(`  Total Quotes Evaluated:   ${result.summary.totalQuotesGenerated.toLocaleString()}`);
  console.log(`  Quote-Valid Evaluations:  ${result.summary.quoteValidEvaluations.toLocaleString()} (${result.summary.validQuotePercentage}%)`);
  console.log(`  Quote Latency (p50 / p95): ${result.summary.averageQuoteLatencyUs} us / ${result.summary.quoteLatencyP95Us} us`);
  console.log(`  WebSocket Messages:       ${result.summary.totalWsMessages.toLocaleString()}`);
  console.log(`  RPC Requests Total:       ${result.summary.totalRpcRequests.toLocaleString()}`);
  console.log(`  Event Queue Drops:        ${result.summary.queueDropsTotal}`);
  console.log(`  Persistence Errors:       ${result.summary.persistenceErrorsTotal}`);
  console.log(`  Peak RSS Memory:          ${result.summary.peakMemoryRssMb} MB`);
  console.log('----------------------------------------------------------------');
  console.log('  CHECKPOINTS STATUS:');
  console.log(`    Verified Routes 250:   ${result.checkpoints.verifiedRoutes['250'].reached ? `REACHED at T+${result.checkpoints.verifiedRoutes['250'].reachedAtSecond}s` : 'NOT REACHED'}`);
  console.log(`    Verified Routes 500:   ${result.checkpoints.verifiedRoutes['500'].reached ? `REACHED at T+${result.checkpoints.verifiedRoutes['500'].reachedAtSecond}s` : 'NOT REACHED'}`);
  console.log(`    Verified Routes 1000:  ${result.checkpoints.verifiedRoutes['1000'].reached ? `REACHED at T+${result.checkpoints.verifiedRoutes['1000'].reachedAtSecond}s` : 'NOT REACHED'}`);
  console.log(`    Simultaneous READY 100: ${result.checkpoints.readyRoutes['100'].reached ? `REACHED at T+${result.checkpoints.readyRoutes['100'].reachedAtSecond}s` : 'NOT REACHED'}`);
  console.log(`    Simultaneous READY 250: ${result.checkpoints.readyRoutes['250'].reached ? `REACHED at T+${result.checkpoints.readyRoutes['250'].reachedAtSecond}s` : 'NOT REACHED'}`);
  console.log(`    Simultaneous READY 500: ${result.checkpoints.readyRoutes['500'].reached ? `REACHED at T+${result.checkpoints.readyRoutes['500'].reachedAtSecond}s` : 'NOT REACHED'}`);
  console.log(`    Simultaneous READY 1000:${result.checkpoints.readyRoutes['1000'].reached ? `REACHED at T+${result.checkpoints.readyRoutes['1000'].reachedAtSecond}s` : 'NOT REACHED'}`);
  console.log('----------------------------------------------------------------');
  console.log('  REJECTION BREAKDOWN:');
  for (const [reason, count] of Object.entries(result.summary.rejectionBreakdownSummary)) {
    console.log(`    ${reason.padEnd(30)}: ${count} routes`);
  }
  console.log('================================================================\n');

  // Persist JSON output
  const outFile = path.join(projectRoot, 'data/benchmark_phase1_6_coverage_10min.json');
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`[MainnetBenchmark] Saved full benchmark results to ${outFile}`);

  return result;
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith('phase1_6_mainnet_10min.ts')) {
  const args = process.argv.slice(2);
  const durationArgIdx = args.indexOf('--duration');
  const duration = durationArgIdx !== -1 && args[durationArgIdx + 1] ? parseInt(args[durationArgIdx + 1], 10) : 600;

  runMainnet10MinBenchmark(duration)
    .then(() => {
      console.log('[MainnetBenchmark] Completed successfully.');
      process.exit(0);
    })
    .catch(err => {
      console.error('[MainnetBenchmark] Fatal error:', err);
      process.exit(1);
    });
}
