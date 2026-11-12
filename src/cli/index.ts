import { config } from '../config/index.js';
import { ArbitrageScanner } from '../scanner/arbitrageScanner.js';
import { ArbitrageCandidate } from '../types/index.js';

console.log('================================================================');
console.log('  SOLANA ARBITRAGE BOT - PHASE 1: READ-ONLY SCANNER             ');
console.log('  (Strictly Read-Only: No Private Keys, No Execution, No Funds) ');
console.log('================================================================');
console.log(`RPC HTTP:            ${config.SOLANA_RPC_HTTP}`);
console.log(`RPC WS:              ${config.SOLANA_RPC_WS}`);
console.log(`Tokens Monitored:    ${config.SCAN_TOKENS} (WSOL & USDC Canonical)`);
console.log(`Simulated Sizes:     $${config.parsedTradeSizesUSDC.join(', $')} USDC`);
console.log(`Min Net Target:      $${config.MIN_NET_PROFIT_USDC.toFixed(2)} USDC`);
console.log(`Safety Buffer:       $${config.SAFETY_BUFFER_USDC.toFixed(2)} USDC`);
console.log(`Max Quote Age:       ${config.MAX_QUOTE_AGE_MS} ms`);
console.log(`Max Slot Gap:        ${config.MAX_SLOT_GAP} slots`);
console.log('----------------------------------------------------------------\n');

const scanner = new ArbitrageScanner(config);

function formatCandidateLog(c: ArbitrageCandidate): string {
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nStopping scanner gracefully...');
  clearInterval(summaryInterval);
  scanner.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nStopping scanner gracefully...');
  clearInterval(summaryInterval);
  scanner.stop();
  process.exit(0);
});

scanner.start().catch((err) => {
  console.error('Fatal scanner error:', err);
  process.exit(1);
});
