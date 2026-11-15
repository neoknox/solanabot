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
  evaluationsPerSecond: number;
  rejectionBreakdown: Record<string, number>;
  configuredBlockers?: Record<string, number>;
  verifiedBottlenecks?: Record<string, number>;
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
    freshlyVerifiedRoutesCount: number;
    unvalidatedRoutesCount: number;
    currentlyReadyRoutes: number;
    verifiedPoolsTotal: number;
    clmmActivatedPoolsTotal: number;
    clmmPricingRejections: Record<string, number>;
    totalPoolsInUniverse: number;
    totalQuotesGenerated: number;
    quoteValidEvaluations: number;
    validQuotePercentage: number;
    averageQuoteLatencyUs: number;
    quoteLatencyP95Us: number;
    inMemoryQuoteSizingLatencyP50Us: number;
    inMemoryQuoteSizingLatencyP95Us: number;
    detectionToDecisionLatencyP50Us: number;
    detectionToDecisionLatencyP95Us: number;
    averageRpcLatencyMs: number;
    totalRpcRequests: number;
    totalWsMessages: number;
    queueDropsTotal: number;
    persistenceErrorsTotal: number;
    peakMemoryRssMb: number;
    rejectionBreakdownSummary: Record<string, number>;
    configuredBlockersSummary: Record<string, number>;
    verifiedBottlenecksSummary: Record<string, number>;
    // Hyperspeed Multi-Stage & Survival Telemetry
    hyperspeedLatency?: {
      t0ToT6TotalUs: { count: number; p50: number | null; p95: number | null; p99: number | null };
      rejectedDecisionUs: { count: number; p50: number | null; p95: number | null; p99: number | null };
      queueWaitUs: { count: number; p50: number | null; p95: number | null; p99: number | null };
      routeLookupUs: { count: number; p50: number | null; p95: number | null; p99: number | null };
      stagesUs: {
        t0ToT1Decode: { count: number; p50: number | null; p95: number | null; p99: number | null };
        t1ToT2Cache: { count: number; p50: number | null; p95: number | null; p99: number | null };
        t2ToT3Routes: { count: number; p50: number | null; p95: number | null; p99: number | null };
        t3ToT4Quoting: { count: number; p50: number | null; p95: number | null; p99: number | null };
        t4ToT5Calc: { count: number; p50: number | null; p95: number | null; p99: number | null };
        t5ToT6Signal: { count: number; p50: number | null; p95: number | null; p99: number | null };
        revalidationDuration: { count: number; p50: number | null; p95: number | null; p99: number | null };
      };
      survival: {
        qualifiedSignalsCount: number;
        revalidatedSignalsCount: number;
        revalidationSurvivalPercentage: number | null;
        accumulatedConservativeNetUSDC: number;
        signalsPerMinute: number;
        revalidatedPerMinute: number;
        netUSDCPerMinute: number;
        disappearanceReasons: Record<string, number>;
      };
      persistence: {
        candidateOverflowCount: number;
        readinessRetryCount: number;
        persistenceErrorsCount: number;
      };
    };
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
    const configuredBlockers = scanner.getBottleneckBreakdown();
    const verifiedBottlenecks = scanner.getVerifiedBottleneckBreakdown();

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
      evaluationsPerSecond: quotesPerSecond,
      rejectionBreakdown: { ...configuredBlockers },
      configuredBlockers: { ...configuredBlockers },
      verifiedBottlenecks: { ...verifiedBottlenecks },
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

  // Compute summary metrics while scanner is still active
  const readySummary = routeIndex.getReadyMetricsSummary();
  const uptimeReport = scanner.getRouteUptimeReport(totalSessionMs);
  const finalAudit = scanner.getAuditMetrics();
  const finalLatency = scanner.getLatencyReport();
  const finalRejections = scanner.getRejectionBreakdown();

  const activeSamples = samples.filter(s => (s.configuredBlockers?.websocketDelay ?? 0) < s.storedRoutes);
  const repSample = activeSamples.length > 0 ? activeSamples[activeSamples.length - 1] : samples[samples.length - 1];
  const finalConfiguredBlockers = repSample?.configuredBlockers || scanner.getBottleneckBreakdown();
  const finalVerifiedBottlenecks = repSample?.verifiedBottlenecks || scanner.getVerifiedBottleneckBreakdown();

  console.log('[MainnetBenchmark] Observation completed. Stopping scanner...');
  scanner.stop();
  const peakMemRss = Math.max(...samples.map(s => s.rssMb), 0);
  const totalEvaluatedFinal = finalAudit.totalEvaluated || 0;
  const quoteValidFinal = finalAudit.quoteValidRouteCount || 0;

  const result: Phase16BenchmarkResult = {
    metadata: {
      title: 'SolanaBot Phase 1.6 Quote Accuracy Gate Mainnet Benchmark',
      description: 'Continuous read-only observation with Raydium CLMM dynamic AmmConfig fee and bidirectional tick hydration',
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
      freshlyVerifiedRoutesCount: routeIndex.getRouteCountByState('VERIFIED'),
      unvalidatedRoutesCount: routeIndex.getUnvalidatedRouteCount(),
      currentlyReadyRoutes: routeIndex.getReadyRouteCount(),
      verifiedPoolsTotal: poolReg.getAllPools().filter(p => p.verificationStatus === 'VERIFIED_DIRECT').length,
      clmmActivatedPoolsTotal: poolReg.getAllPools().filter(p => p.dex === 'RAYDIUM_CLMM' && p.verificationStatus === 'VERIFIED_DIRECT').length,
      clmmPricingRejections: {
        MISSING_TICK_DATA: finalRejections['MISSING_TICK_DATA'] || 0,
        UNSUPPORTED_AMM_CONFIG: finalRejections['UNSUPPORTED_AMM_CONFIG'] || 0,
        QUOTE_UNVERIFIED: finalRejections['QUOTE_UNVERIFIED'] || 0,
        TICK_BOUNDARY_EXCEEDED: finalRejections['TICK_BOUNDARY_EXCEEDED'] || 0,
        EXCESSIVE_PRICE_IMPACT: finalRejections['EXCESSIVE_PRICE_IMPACT'] || 0
      },
      totalPoolsInUniverse: poolReg.getAllPools().length,
      totalQuotesGenerated: totalEvaluatedFinal,
      quoteValidEvaluations: quoteValidFinal,
      validQuotePercentage: totalEvaluatedFinal > 0 ? Number(((quoteValidFinal / totalEvaluatedFinal) * 100).toFixed(2)) : 0,
      averageQuoteLatencyUs: Number((finalLatency.quoteLatencyUs?.p50 || 0).toFixed(1)),
      quoteLatencyP95Us: Number((finalLatency.quoteLatencyUs?.p95 || 0).toFixed(1)),
      inMemoryQuoteSizingLatencyP50Us: Number((finalLatency.quoteLatencyUs?.p50 || 0).toFixed(1)),
      inMemoryQuoteSizingLatencyP95Us: Number((finalLatency.quoteLatencyUs?.p95 || 0).toFixed(1)),
      detectionToDecisionLatencyP50Us: Number((finalLatency.detectionToDecisionUs?.p50 || 0).toFixed(1)),
      detectionToDecisionLatencyP95Us: Number((finalLatency.detectionToDecisionUs?.p95 || 0).toFixed(1)),
      averageRpcLatencyMs: Number((finalLatency.rpcLatencyMs?.p50 || 0).toFixed(1)),
      totalRpcRequests: scanner.getRpc().getStats().requestsTotal,
      totalWsMessages: scanner.getWs().getStats().messagesTotal || 0,
      queueDropsTotal: scanner.getEventQueueStats().droppedCount,
      persistenceErrorsTotal: repo.getPersistenceErrorsCount(),
      peakMemoryRssMb: peakMemRss,
      rejectionBreakdownSummary: { ...finalRejections },
      configuredBlockersSummary: { ...finalConfiguredBlockers },
      verifiedBottlenecksSummary: { ...finalVerifiedBottlenecks },
      hyperspeedLatency: {
        t0ToT6TotalUs: {
          count: finalLatency.t0ToT6TotalUs.count,
          p50: finalLatency.t0ToT6TotalUs.p50,
          p95: finalLatency.t0ToT6TotalUs.p95,
          p99: finalLatency.t0ToT6TotalUs.p99
        },
        rejectedDecisionUs: {
          count: finalLatency.rejectedDecisionUs.count,
          p50: finalLatency.rejectedDecisionUs.p50,
          p95: finalLatency.rejectedDecisionUs.p95,
          p99: finalLatency.rejectedDecisionUs.p99
        },
        queueWaitUs: {
          count: finalLatency.queueWaitUs.count,
          p50: finalLatency.queueWaitUs.p50,
          p95: finalLatency.queueWaitUs.p95,
          p99: finalLatency.queueWaitUs.p99
        },
        routeLookupUs: {
          count: finalLatency.routeLookupUs.count,
          p50: finalLatency.routeLookupUs.p50,
          p95: finalLatency.routeLookupUs.p95,
          p99: finalLatency.routeLookupUs.p99
        },
        stagesUs: {
          t0ToT1Decode: {
            count: finalLatency.t0ToT1DecodeUs.count,
            p50: finalLatency.t0ToT1DecodeUs.p50,
            p95: finalLatency.t0ToT1DecodeUs.p95,
            p99: finalLatency.t0ToT1DecodeUs.p99
          },
          t1ToT2Cache: {
            count: finalLatency.t1ToT2CacheUs.count,
            p50: finalLatency.t1ToT2CacheUs.p50,
            p95: finalLatency.t1ToT2CacheUs.p95,
            p99: finalLatency.t1ToT2CacheUs.p99
          },
          t2ToT3Routes: {
            count: finalLatency.t2ToT3RoutesUs.count,
            p50: finalLatency.t2ToT3RoutesUs.p50,
            p95: finalLatency.t2ToT3RoutesUs.p95,
            p99: finalLatency.t2ToT3RoutesUs.p99
          },
          t3ToT4Quoting: {
            count: finalLatency.t3ToT4QuotingUs.count,
            p50: finalLatency.t3ToT4QuotingUs.p50,
            p95: finalLatency.t3ToT4QuotingUs.p95,
            p99: finalLatency.t3ToT4QuotingUs.p99
          },
          t4ToT5Calc: {
            count: finalLatency.t4ToT5CalcUs.count,
            p50: finalLatency.t4ToT5CalcUs.p50,
            p95: finalLatency.t4ToT5CalcUs.p95,
            p99: finalLatency.t4ToT5CalcUs.p99
          },
          t5ToT6Signal: {
            count: finalLatency.t5ToT6SignalUs.count,
            p50: finalLatency.t5ToT6SignalUs.p50,
            p95: finalLatency.t5ToT6SignalUs.p95,
            p99: finalLatency.t5ToT6SignalUs.p99
          },
          revalidationDuration: {
            count: finalLatency.revalidationDurationUs.count,
            p50: finalLatency.revalidationDurationUs.p50,
            p95: finalLatency.revalidationDurationUs.p95,
            p99: finalLatency.revalidationDurationUs.p99
          }
        },
        survival: {
          qualifiedSignalsCount: finalLatency.survivalStats.qualifiedSignalsCount,
          revalidatedSignalsCount: finalLatency.survivalStats.revalidatedSignalsCount,
          revalidationSurvivalPercentage: finalLatency.survivalStats.revalidationSurvivalPercentage,
          accumulatedConservativeNetUSDC: finalLatency.survivalStats.accumulatedConservativeNetUSDC,
          signalsPerMinute: Number((finalLatency.survivalStats.qualifiedSignalsCount / (durationSeconds / 60)).toFixed(2)),
          revalidatedPerMinute: Number((finalLatency.survivalStats.revalidatedSignalsCount / (durationSeconds / 60)).toFixed(2)),
          netUSDCPerMinute: Number((finalLatency.survivalStats.accumulatedConservativeNetUSDC / (durationSeconds / 60)).toFixed(4)),
          disappearanceReasons: { ...finalLatency.survivalStats.disappearanceReasons }
        },
        persistence: {
          candidateOverflowCount: scanner.getPersistenceStats().candidateOverflowCount,
          readinessRetryCount: scanner.getPersistenceStats().readinessRetryCount,
          persistenceErrorsCount: scanner.getPersistenceStats().persistenceErrorsCount
        }
      }
    },
    samples
  };

  const fmtP = (s?: { count: number; p50: number | null; p95: number | null; p99?: number | null }, unit: string = 'μs') => {
    if (!s || s.p50 === null) return `p50: N/A | p95: N/A (n=${s?.count ?? 0})`;
    const p99 = s.p99 !== undefined && s.p99 !== null ? ` | p99: ${s.p99.toFixed(1)} ${unit}` : '';
    return `p50: ${s.p50.toFixed(1)} ${unit} | p95: ${(s.p95 ?? 0).toFixed(1)} ${unit}${p99} (n=${s.count})`;
  };

  console.log('\n================================================================');
  console.log('   PHASE 1.6 BENCHMARK EMPIRICAL REPORT SUMMARY');
  console.log('================================================================');
  console.log(`  Duration:                 ${durationSeconds} seconds`);
  console.log(`  Total Pools in Registry:  ${result.summary.totalPoolsInUniverse}`);
  console.log(`  Verified Pools (Direct):  ${result.summary.verifiedPoolsTotal}`);
  console.log(`  Active CLMM Pools:        ${result.summary.clmmActivatedPoolsTotal}`);
  console.log(`  Total Configured Routes:  ${result.summary.totalConfiguredRoutes}`);
  console.log(`  Unique Stored Routes:     ${result.summary.uniqueRoutesCount}`);
  console.log(`  Restored Routes:          ${result.summary.restoredRoutesCount}`);
  console.log(`  Structurally Verified:    ${result.summary.verifiedRoutesTotal}`);
  console.log(`  Freshly Verified State:   ${result.summary.freshlyVerifiedRoutesCount}`);
  console.log(`  Unvalidated Routes:       ${result.summary.unvalidatedRoutesCount}`);
  console.log('----------------------------------------------------------------');
  console.log(`  Currently READY Routes:   ${result.summary.currentlyReadyRoutes}`);
  console.log(`  Peak READY Routes:        ${result.summary.peakReady}`);
  console.log(`  Min READY Routes:         ${result.summary.minReady}`);
  console.log(`  Average READY Routes:     ${result.summary.averageReady}`);
  console.log(`  p10 READY Routes:         ${result.summary.p10ReadyCount}`);
  console.log(`  READY Route Uptime:       ${result.summary.readyUptimePercent}%`);
  console.log('----------------------------------------------------------------');
  console.log(`  Total Quotes Evaluated:   ${result.summary.totalQuotesGenerated.toLocaleString()}`);
  console.log(`  Quote-Valid Evaluations:  ${result.summary.quoteValidEvaluations.toLocaleString()} (${result.summary.validQuotePercentage}%)`);
  console.log('----------------------------------------------------------------');
  console.log('  EMPIRICAL LATENCY & THROUGHPUT (HONEST BENCHMARK TELEMETRY):');
  console.log(`    Route Evaluations/sec:        ${Math.round(totalEvaluatedFinal / Math.max(1, durationSeconds))}`);
  console.log(`    In-Memory Sizing (p50 / p95): ${result.summary.inMemoryQuoteSizingLatencyP50Us} us / ${result.summary.inMemoryQuoteSizingLatencyP95Us} us`);
  console.log(`    Detection-to-Decision (p50/p95): ${result.summary.detectionToDecisionLatencyP50Us} us / ${result.summary.detectionToDecisionLatencyP95Us} us`);
  console.log(`    RPC Roundtrip Latency (p50):  ${result.summary.averageRpcLatencyMs} ms`);
  console.log(`    WebSocket Messages:           ${result.summary.totalWsMessages.toLocaleString()}`);
  console.log(`    RPC Requests Total:           ${result.summary.totalRpcRequests.toLocaleString()}`);
  console.log(`    Event Queue Drops:            ${result.summary.queueDropsTotal}`);
  console.log(`    Persistence Errors:           ${result.summary.persistenceErrorsTotal}`);
  console.log(`    Peak RSS Memory:              ${result.summary.peakMemoryRssMb} MB`);
  console.log('----------------------------------------------------------------');
  console.log('  PROJECT HYPERSPEED — MULTI-STAGE LATENCY & SURVIVAL TELEMETRY:');
  const hs = result.summary.hyperspeedLatency;
  if (hs) {
    console.log(`    T0 -> T6 Qualified Signal: ${fmtP(hs.t0ToT6TotalUs)}`);
    console.log(`    Rejected Decisions:        ${fmtP(hs.rejectedDecisionUs)}`);
    console.log(`    Queue Waiting Latency:     ${fmtP(hs.queueWaitUs)}`);
    console.log(`    Route Lookup Latency:      ${fmtP(hs.routeLookupUs)}`);
    console.log(`    Stage T0 -> T1 (Decode):   ${fmtP(hs.stagesUs.t0ToT1Decode)}`);
    console.log(`    Stage T1 -> T2 (Cache):    ${fmtP(hs.stagesUs.t1ToT2Cache)}`);
    console.log(`    Stage T2 -> T3 (Routes):   ${fmtP(hs.stagesUs.t2ToT3Routes)}`);
    console.log(`    Stage T3 -> T4 (Quoting):  ${fmtP(hs.stagesUs.t3ToT4Quoting)}`);
    console.log(`    Stage T4 -> T5 (Net Calc): ${fmtP(hs.stagesUs.t4ToT5Calc)}`);
    console.log(`    Stage T5 -> T6 (Signal):   ${fmtP(hs.stagesUs.t5ToT6Signal)}`);
    console.log(`    Stage T6 -> T7 (Reval):    ${fmtP(hs.stagesUs.revalidationDuration)}`);
    console.log('  --------------------------------------------------------------');
    console.log(`    Qualified Shadow Signals:       ${hs.survival.qualifiedSignalsCount} (${hs.survival.signalsPerMinute} / min)`);
    console.log(`    Revalidated Profitable Signals: ${hs.survival.revalidatedSignalsCount} (${hs.survival.revalidatedPerMinute} / min)`);
    const survPctStr = hs.survival.revalidationSurvivalPercentage !== null ? `${hs.survival.revalidationSurvivalPercentage}%` : 'N/A (no qualified signals)';
    console.log(`    Revalidation Survival Rate:     ${survPctStr}`);
    console.log(`    Accumulated Net Profit (USDC):  $${hs.survival.accumulatedConservativeNetUSDC} ($${hs.survival.netUSDCPerMinute} / min)`);
    console.log(`    Persistence Health:             Overflows: ${hs.persistence.candidateOverflowCount} | Retries: ${hs.persistence.readinessRetryCount} | Errors: ${hs.persistence.persistenceErrorsCount}`);
    console.log('    Disappearance Reasons:');
    for (const [reason, count] of Object.entries(hs.survival.disappearanceReasons)) {
      console.log(`      ${reason.padEnd(28)}: ${count}`);
    }
  }
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
  console.log('  ACTUAL ROUTE EVALUATION REJECTION REASONS:');
  for (const [reason, count] of Object.entries(result.summary.rejectionBreakdownSummary)) {
    if (count > 0) {
      console.log(`    ${reason.padEnd(30)}: ${count}`);
    }
  }
  console.log('----------------------------------------------------------------');
  console.log('  BOTTLENECKS AMONG STRUCTURALLY VERIFIED ROUTES:');
  for (const [reason, count] of Object.entries(result.summary.verifiedBottlenecksSummary)) {
    if (count > 0) {
      console.log(`    ${reason.padEnd(30)}: ${count} routes`);
    }
  }
  console.log('----------------------------------------------------------------');
  console.log('  BLOCKERS AMONG ALL CONFIGURED ROUTES:');
  for (const [reason, count] of Object.entries(result.summary.configuredBlockersSummary)) {
    if (count > 0) {
      console.log(`    ${reason.padEnd(30)}: ${count} routes`);
    }
  }
  console.log('----------------------------------------------------------------');
  console.log('  CLMM PRICING REJECTION COUNTS:');
  for (const [reason, count] of Object.entries(result.summary.clmmPricingRejections)) {
    console.log(`    ${reason.padEnd(30)}: ${count}`);
  }
  console.log('================================================================\n');

  // Persist JSON output
  const outFile10Min = path.join(projectRoot, 'data/benchmark_phase1_6_coverage_10min.json');
  const outFileGate = path.join(projectRoot, 'data/benchmark_phase1_6_accuracy_gate.json');
  fs.writeFileSync(outFile10Min, JSON.stringify(result, null, 2), 'utf-8');
  fs.writeFileSync(outFileGate, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`[MainnetBenchmark] Saved full benchmark results to ${outFileGate}`);

  return result;
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith('phase1_6_mainnet_10min.ts')) {
  const args = process.argv.slice(2);
  const durationArgIdx = args.indexOf('--duration');
  const duration = durationArgIdx !== -1 && args[durationArgIdx + 1] ? parseInt(args[durationArgIdx + 1], 10) : 600;

  // Explicit safety watchdog: force exit if run exceeds duration + 30s
  const watchdog = setTimeout(() => {
    console.error(`[MainnetBenchmark] STATUS: INCOMPLETE - WATCHDOG TIMEOUT TRIGGERED after ${duration + 30}s.`);
    process.exit(1);
  }, (duration + 30) * 1000);
  watchdog.unref();

  runMainnet10MinBenchmark(duration)
    .then(() => {
      console.log('[MainnetBenchmark] STATUS: COMPLETED. Benchmark finished and persisted successfully.');
      process.exit(0);
    })
    .catch(err => {
      console.error('[MainnetBenchmark] STATUS: INCOMPLETE - Fatal error:', err);
      process.exit(1);
    });
}
