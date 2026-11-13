import { startConnectedScanner } from './index.js';

/**
 * Entrypoint for `npm run hud`.
 * Launches ONE connected scanner + HUD process sharing ONE authoritative ProfitThresholdManager.
 */
startConnectedScanner().catch((err) => {
  console.error('Fatal scanner + HUD error:', err);
  process.exit(1);
});
