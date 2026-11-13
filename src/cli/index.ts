import path from 'path';
import { config, AppConfig } from '../config/index.js';
import { ArbitrageScanner } from '../scanner/arbitrageScanner.js';
import { ProfitHudServer } from '../hud/profitHudServer.js';
import { ArbitrageCandidate } from '../types/index.js';

export function formatCandidateLog(c: ArbitrageCandidate): string {
  const time = new Date(c.timestamp).toISOString();
  const inputUSD = (Number(c.inputAmountUSDC) / 1e6).toFixed(2);
  const out1WSOL = (Number(c.leg1ExpectedOutWSOL) / 1e9).toFixed(5);
  const out2USD = (Number(c.leg2ExpectedOutUSDC) / 1e6).toFixed(2);

  const statusColor = c.status === 'QUALIFIED_SHADOW' ? '[QUALIFIED]' : `[${c.status}]`;
  const reasons = c.rejectionReasons.length > 0 ? `Reasons: ${c.rejectionReasons.join(', ')}` : 'Passes all rules';

  return [
    `[${time}] ${statusColor} ${c.routeName}`,
    `  Size: $${inputUSD} USDC -> Leg1 Out: ${out1WSOL} WSOL -> Leg2 Out: $${out2USD} USDC`,
    `  Expected Net: $${c.expectedNetUSDC} | Conservative Net: $${c.minConservativeNetUSDC}`,
    `  Costs: $${c.costs.totalCostsUSDC} (Base: $${c.costs.networkFeeUSDC}, Prio: $${c.costs.priorityFeeUSDC}, Buffer: $${c.costs.safetyBufferUSDC})`,
    `  Quote Age: ${c.quoteAgeMs}ms | Slot Gap: ${c.slotGap} | ${reasons}`
  ].join('\n');
}

/**
 * Starts ONE connected scanner + HUD process.
 * Uses ONE authoritative ProfitThresholdManager shared synchronously across the scanner and HUD.
 */
export async function startConnectedScanner(customConfig: AppConfig = config) {
  const scanner = new ArbitrageScanner(customConfig);
  const thresholdManager = scanner.getProfitThresholdManager();
  const hudServer = new ProfitHudServer(thresholdManager, scanner, { port: customConfig.HUD_PORT });

  console.log('================================================================');
  console.log('  SOLANA ARBITRAGE BOT - PHASE 1: READ-ONLY SCANNER + HUD       ');
  console.log('  (Strictly Read-Only: No Private Keys, No Execution, No Funds) ');
  console.log('================================================================');
  console.log(`RPC HTTP:            ${customConfig.SOLANA_RPC_HTTP}`);
  console.log(`RPC WS:              ${customConfig.SOLANA_RPC_WS}`);
  console.log(`Tokens Monitored:    ${customConfig.SCAN_TOKENS} (WSOL & USDC Canonical)`);
  console.log(`Simulated Sizes:     $${customConfig.parsedTradeSizesUSDC.join(', $')} USDC`);
  console.log(`Min Net Target:      ${thresholdManager.getFormattedThreshold()} (Live Adjustable via HUD)`);
  console.log(`Safety Buffer:       $${customConfig.SAFETY_BUFFER_USDC.toFixed(2)} USDC`);
  console.log(`Max Quote Age:       ${customConfig.MAX_QUOTE_AGE_MS} ms`);
  console.log(`Max Slot Gap:        ${customConfig.MAX_SLOT_GAP} slots`);
  console.log(`HUD Web Control:     http://127.0.0.1:${customConfig.HUD_PORT} [READ-ONLY / SHADOW MODE]`);
  console.log('----------------------------------------------------------------\n');

  // Listen to candidates
  scanner.onCandidate((candidate) => {
    if (candidate.status === 'QUALIFIED_SHADOW' || candidate.status === 'CANDIDATE') {
      console.log(formatCandidateLog(candidate));
      console.log('');
    }
  });

  // Periodic dashboard summary
  const summaryInterval = setInterval(() => {
    const health = scanner.getHealthStatus();
    const wsStatus = health.connectedWs ? 'CONNECTED' : 'DISCONNECTED';
    const rpcStatus = health.connectedRpc ? 'ACTIVE' : 'DEGRADED';

    console.log('--- SCANNER HEALTH & METRICS ---');
    console.log(`Slot: ${health.currentSlot || 'Awaiting'} | RPC: ${rpcStatus} | WS: ${wsStatus} | Jupiter: ${health.jupiterStatus}`);
    console.log(`Quotes Rate: ${health.quotesPerSecond}/s | Active Pools: ${health.activePoolCount}`);
    console.log(`Pools Breakdown: ${JSON.stringify(health.poolsPerDex)}`);
    console.log(`Opportunities: Qualified=${health.qualifiedCount} | Rejected=${health.rejectedCount}`);

    const topRejections = Object.entries(health.rejectionBreakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([r, count]) => `${r}: ${count}`)
      .join(' | ');

    if (topRejections) {
      console.log(`Top Rejection Codes: ${topRejections}`);
    }

    if (!health.connectedWs) {
      console.warn('WARNING: Solana WebSocket disconnected. Scanner state cache is invalidated.');
    }
    if (health.jupiterStatus === 'RATE_LIMITED') {
      console.warn('WARNING: Jupiter rate limit reached. Backoff active.');
    }
    console.log('--------------------------------\n');
  }, 10000);

  const cleanup = async () => {
    console.log('\nStopping scanner and HUD gracefully...');
    clearInterval(summaryInterval);
    await hudServer.stop();
    scanner.stop();
  };

  process.once('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  process.once('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  // Start HUD server first; if port is occupied, fail fast with actionable error
  try {
    await hudServer.start();
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[FATAL] HUD port ${customConfig.HUD_PORT} is already occupied by another process.`);
      console.error(`Ensure no other scanner or HUD instance is running, or set a different HUD_PORT in .env (e.g. HUD_PORT=3031).\n`);
      process.exit(1);
    }
    console.error('\n[FATAL] Failed to start HUD server:', err.message || err);
    process.exit(1);
  }

  // Start scanner background loops
  await scanner.start();

  return { scanner, hudServer, thresholdManager, cleanup };
}

// Detect direct CLI execution of src/cli/index.ts
const executedFile = process.argv[1] ? path.normalize(path.resolve(process.argv[1])).toLowerCase() : '';
const isCliIndex = executedFile.endsWith(path.join('cli', 'index.ts')) || executedFile.endsWith(path.join('cli', 'index.js'));

if (isCliIndex) {
  startConnectedScanner().catch((err) => {
    console.error('Fatal scanner error:', err);
    process.exit(1);
  });
}
