import { loadConfig } from '../src/config/index.js';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { RouteIndex } from '../src/scanner/routeIndex.js';

async function diagnose() {
  const config = loadConfig();
  const repo = new ArbitrageRepository(config);
  
  // 1. Database check
  const dbCount = repo.getRouteCount();
  console.log(`[DB] Total routes in DB: ${dbCount}`);

  const dbRows = repo.getAllRoutes();
  console.log(`[DB] Fetched routes count: ${dbRows.length}`);

  // Check state distribution in DB
  const dbStateCounts = new Map<string, number>();
  const dbIds = new Set<string>();
  let dbDuplicates = 0;

  for (const r of dbRows) {
    dbStateCounts.set(r.state, (dbStateCounts.get(r.state) || 0) + 1);
    if (dbIds.has(r.routeId)) {
      dbDuplicates++;
    }
    dbIds.add(r.routeId);
  }
  console.log(`[DB] Unique routeIds: ${dbIds.size}, Duplicates: ${dbDuplicates}`);
  console.log('[DB] State distribution:');
  for (const [st, cnt] of dbStateCounts.entries()) {
    console.log(`   ${st}: ${cnt}`);
  }

  // 2. RouteIndex in-memory check
  const pools = repo.getAllVerifiedPools();
  console.log(`\n[POOLS] Verified pools in DB: ${pools.length}`);

  const routeIndex = new RouteIndex([]);
  // Simulate how scanner populates routeIndex
  routeIndex.syncWithLibrary(dbRows);

  const runtimeCount = routeIndex.getRouteCount();
  const verified = routeIndex.getRouteCountByState('VERIFIED');
  const ready = routeIndex.getRouteCountByState('READY');
  const stale = routeIndex.getRouteCountByState('STALE');
  const blocked = routeIndex.getRouteCountByState('BLOCKED');
  const unvalidated = routeIndex.getRouteCountByState('UNVALIDATED');

  const displayedSum = verified + ready + stale + blocked + unvalidated;

  console.log(`\n[RouteIndex] getRouteCount(): ${runtimeCount}`);
  console.log(`[RouteIndex] Sum of displayed states: ${displayedSum}`);
  console.log(`   VERIFIED: ${verified}`);
  console.log(`   READY: ${ready}`);
  console.log(`   STALE: ${stale}`);
  console.log(`   BLOCKED: ${blocked}`);
  console.log(`   UNVALIDATED: ${unvalidated}`);
  console.log(`   DIFFERENCE: ${runtimeCount - displayedSum}`);

  // Find routes in routeIndex that are not in any displayed state
  const allRoutes = routeIndex.getAllRoutes();
  console.log(`[RouteIndex] getAllRoutes().length: ${allRoutes.length}`);

  const unindexedRoutes: Array<{ id: string; state: string }> = [];
  const stateCountsRuntime = new Map<string, number>();
  for (const r of allRoutes) {
    stateCountsRuntime.set(r.state, (stateCountsRuntime.get(r.state) || 0) + 1);
    const inState = (routeIndex as any).routesByState.get(r.state)?.has(r.routeId);
    if (!inState) {
      unindexedRoutes.push({ id: r.routeId, state: r.state });
    }
  }

  console.log('\n[RouteIndex] Actual route.state values across allRoutes:');
  for (const [st, cnt] of stateCountsRuntime.entries()) {
    console.log(`   ${st}: ${cnt}`);
  }

  console.log(`[RouteIndex] Routes whose route.state is NOT in routesByState: ${unindexedRoutes.length}`);
  if (unindexedRoutes.length > 0) {
    console.log('Sample unindexed routes:');
    console.log(unindexedRoutes.slice(0, 10));
  }

  repo.close();
}

diagnose().catch(err => {
  console.error('Diagnostic error:', err);
  process.exit(1);
});
