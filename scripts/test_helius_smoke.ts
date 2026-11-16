import { loadConfig } from '../src/config/index.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { SolanaWsProvider } from '../src/providers/solanaWs.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';

import { PublicKey } from '@solana/web3.js';

function maskUrl(urlStr?: string): string {
  if (!urlStr) return '(not set)';
  try {
    const parsed = new URL(urlStr);
    const hasKey = parsed.searchParams.has('api-key');
    return `${parsed.protocol}//${parsed.hostname}?api-key=${hasKey ? '***' : '(none)'}`;
  } catch {
    return '(invalid url)';
  }
}

async function runHeliusSmokeTest() {
  console.log('================================================================');
  console.log('   SOLANABOT — HELIUS FREE CONNECTION & PIPELINE SMOKE TEST');
  console.log('================================================================\n');

  const config = loadConfig();
  console.log('[CONFIG] HTTP Endpoint:', maskUrl(config.SOLANA_RPC_HTTP));
  console.log('[CONFIG] WS Endpoint:  ', maskUrl(config.SOLANA_RPC_WS));
  console.log('[CONFIG] WS Cap:       ', config.MAX_WS_SUBSCRIPTIONS);

  // 1. HTTP RPC Test
  console.log('\n[1/4] Testing Helius HTTP RPC...');
  const rpc = new SolanaRpcProvider(config);
  const t0 = performance.now();
  const currentSlot = await rpc.getSlot();
  const rpcLatency = Math.round(performance.now() - t0);
  console.log(`[HTTP] Connected successfully! Current Slot: ${currentSlot} (Latency: ${rpcLatency}ms)`);

  // Test getMultipleAccountsAndContext for priority pool
  const testPoolId = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
  const tBatch = performance.now();
  const batchRes = await rpc.getMultipleAccounts([new PublicKey(testPoolId)]);
  const batchLatency = Math.round(performance.now() - tBatch);
  console.log(`[HTTP] Batch account query successful! Pool account size: ${batchRes[0]?.data.length || 0} bytes (Latency: ${batchLatency}ms)`);

  // 2. WebSocket Connection & Slot Subscription Test
  console.log('\n[2/4] Testing Helius WebSocket & Slot Subscription...');
  const ws = new SolanaWsProvider(config);
  let slotReceived = false;
  let firstSlot = 0;
  let accountUpdateReceived = false;

  const connected = await ws.connect(10000);
  console.log(`[WS] Connection result: ${connected ? 'SUCCESS' : 'FAILED'} (Stage: ${ws.getConnectionStage()})`);

  if (!connected) {
    throw new Error(`Failed to connect to Helius WebSocket: ${ws.getLastError()}`);
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Helius WebSocket slot / account update timed out after 10s'));
    }, 10000);

    ws.onSlot((slot) => {
      if (!slotReceived) {
        slotReceived = true;
        firstSlot = slot;
        console.log(`[WS] Slot notification received from Helius! Live Slot: ${slot}`);

        // Subscribe to a high-volume account
        console.log('\n[3/4] Testing Account Subscription Confirmation on Helius...');
        const subscribed = ws.subscribeAccount(testPoolId, (data, s) => {
          if (!accountUpdateReceived) {
            accountUpdateReceived = true;
            console.log(`[WS] Account update notification received for pool at slot ${s} (${data.length} bytes)!`);
            clearTimeout(timeout);
            resolve();
          }
        });
        console.log(`[WS] Account subscription dispatched (Accepted: ${subscribed})`);
      }
    });
  });

  const wsStats = ws.getStats();
  console.log(`[WS] Confirmed subscriptions on Helius: ${wsStats.confirmedSubscriptionCount}`);
  ws.disconnect();

  // 4. Scanner Integration & Two-Leg Quote Generation Test
  console.log('\n[4/4] Testing Scanner Integration & Two-Leg Quote Generation...');
  const thresholdManager = new ProfitThresholdManager({ silent: true });
  const scanner = new ArbitrageScanner(
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    thresholdManager
  );

  console.log('[SCANNER] Starting scanner...');
  await scanner.start();

  console.log('[SCANNER] Waiting 12 seconds for Helius pool snapshot hydration and live quote generation...');
  await new Promise(r => setTimeout(r, 12000));

  const hud = scanner.getHudV2Data();
  const coverage = scanner.getCoverageBreakdown();
  const audit = scanner.getAuditMetrics();

  console.log('\n--- Helius Smoke Test Results ---');
  console.log(`  WS Status:                      ${hud.wsStatus}`);
  console.log(`  Current Slot:                   ${hud.solanaSlot}`);
  console.log(`  Registered Pools:               ${coverage.registeredPools}`);
  console.log(`  On-Chain Verified Pools:        ${coverage.onChainVerifiedPools}`);
  console.log(`  Fully Monitored Pool Bundles:   ${coverage.fullyMonitoredPoolBundles}`);
  console.log(`  Confirmed Account Subs:         ${coverage.confirmedAccountSubscriptions}`);
  console.log(`  Currently READY Routes:         ${coverage.routesGenuinelyReady}`);
  console.log(`  Total Evaluated:                ${audit.totalEvaluated}`);
  console.log(`  Quote-Valid Evaluations:        ${audit.quoteValidRouteCount || 0}`);
  console.log(`  Quote-Valid Percentage:         ${hud.performance.quoteValidPercentage}%`);
  console.log(`  Quote-Producing Scanner Uptime: ${hud.routeHealth.quoteProducingScannerUptimePercent}%`);
  console.log(`  RPC p95 Latency:                ${hud.performance.rpcLatencyP95Ms} ms`);

  scanner.stop();

  if ((audit.quoteValidRouteCount || 0) > 0) {
    console.log('\n>>> SUCCESS: Helius Free smoke test PASSED with nonzero quote generation! <<<');
  } else {
    console.warn('\n>>> WARNING: Zero valid quotes produced during quick smoke test. Check pool state hydration. <<<');
  }
}

runHeliusSmokeTest().catch((err) => {
  console.error('[SMOKE TEST FATAL ERROR]:', err);
  process.exit(1);
});
