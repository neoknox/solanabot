import path from 'path';
import { config } from '../config/index.js';
import { ArbitrageRepository } from '../storage/repository.js';

const exportPath = path.resolve(process.cwd(), 'data', 'arbitrage_candidates.csv');
console.log(`Exporting signals to CSV: ${exportPath}...`);

const repo = new ArbitrageRepository(config);
try {
  const count = repo.exportToCsv(exportPath);
  console.log(`[SUCCESS] Exported ${count} candidate rows to ${exportPath}`);
} catch (err) {
  console.error('[ERROR] Failed to export CSV:', err);
  process.exit(1);
} finally {
  repo.close();
}
