import { config } from '../config/index.js';
import { ArbitrageScanner } from '../scanner/arbitrageScanner.js';

async function main() {
  console.log('================================================================');
  console.log('  SOLANA ARBITRAGE BOT - LIVE MAINNET SMOKE TEST                ');
  console.log('  (Strictly Read-Only: No Private Keys, No Execution, No Funds) ');
  console.log('================================================================');
  console.log(`Connecting to Solana RPC: ${config.SOLANA_RPC_HTTP}`);
  console.log(`Connecting to Solana WS:  ${config.SOLANA_RPC_WS}\n`);

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

  console.log('Running live scan cycle against Solana mainnet for 20 seconds...\n');
  await new Promise(resolve => setTimeout(resolve, 20000));

  const health = scanner.getHealthStatus();
  console.log('================================================================');
  console.log('  MAINNET SMOKE TEST COMPLETED SUCCESSFULLY                     ');
  console.log('================================================================');
  console.log(`Final Solana Slot:      ${health.currentSlot}`);
  console.log(`WebSocket Status:       ${health.connectedWs ? 'CONNECTED' : 'DISCONNECTED'}`);
  console.log(`Active Monitored Pools: ${health.activePoolCount}`);
  console.log(`Pools Per Venue:        ${JSON.stringify(health.poolsPerDex)}`);
  console.log(`Opportunities:          Qualified=${health.qualifiedCount} | Rejected=${health.rejectedCount}`);
  console.log(`Rejection Breakdown:    ${JSON.stringify(health.rejectionBreakdown, null, 2)}`);
  console.log('================================================================\n');

  scanner.stop();
  process.exit(0);
}

main().catch(err => {
  console.error('Smoke test error:', err);
  process.exit(1);
});
