import { config } from '../config/index.js';
import { ProfitThresholdManager } from '../profit/profitThresholdManager.js';
import { ProfitHudServer } from '../hud/profitHudServer.js';

async function main() {
  console.log('================================================================');
  console.log('  SOLANA ARBITRAGE BOT - PROFIT THRESHOLD HUD SERVER             ');
  console.log('  (Strictly Read-Only: No Private Keys, No Execution, No Funds) ');
  console.log('================================================================');

  const manager = new ProfitThresholdManager({
    filePath: config.PROFIT_THRESHOLD_FILE,
    initialThresholdUSDC: config.MIN_NET_PROFIT_USDC
  });

  const server = new ProfitHudServer(manager, undefined, {
    port: config.HUD_PORT
  });

  const info = await server.start();
  console.log(`Local HUD Control:   ${info.url}`);
  console.log(`Initial Threshold:   ${manager.getFormattedThreshold()}`);
  console.log(`Operating Mode:      READ-ONLY / SHADOW MODE`);
  console.log('Press Ctrl+C to terminate server.\n');

  process.on('SIGINT', async () => {
    console.log('\nStopping HUD server...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nStopping HUD server...');
    await server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal HUD server error:', err);
  process.exit(1);
});
