import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig();
const scanner = new ArbitrageScanner(config);
const rh = scanner.getHudV2Data().routeHealth;

console.log('--- SCANNER ROUTE HEALTH COUNTS ---');
console.log('totalUnique2LegRoutes: ', rh.totalUnique2LegRoutes);
console.log('verifiedRoutes:        ', rh.verifiedRoutes);
console.log('readyRoutes:           ', rh.readyRoutes);
console.log('staleRoutes:           ', rh.staleRoutes);
console.log('blockedRoutes:         ', rh.blockedRoutes);
console.log('unvalidatedRoutes:     ', rh.unvalidatedRoutes);

const stateSum = rh.verifiedRoutes + rh.readyRoutes + rh.staleRoutes + rh.blockedRoutes + rh.unvalidatedRoutes;
console.log('Sum of state counts:   ', stateSum);
console.log('Discrepancy (Total - Sum):', rh.totalUnique2LegRoutes - stateSum);
