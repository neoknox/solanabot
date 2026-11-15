import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface CleanupReport {
  timestamp: string;
  dbPath: string;
  fileSizeBytesBefore: number;
  fileSizeBytesAfter: number;
  routesBefore: {
    total: number;
    twoLeg: number;
    threeLeg: number;
  };
  routesAfter: {
    total: number;
    twoLeg: number;
    threeLeg: number;
  };
  deletedRoutesCount: number;
  candidatesBefore: {
    total: number;
    twoLeg: number;
    threeLeg: number;
  };
  candidatesAfter: {
    total: number;
    twoLeg: number;
    threeLeg: number;
  };
  deletedCandidatesCount: number;
  verifiedPoolsBefore: number;
  verifiedPoolsAfter: number;
}

export function cleanupThreeLegDatabase(dbPath: string): CleanupReport {
  const timestamp = new Date().toISOString();
  const fileSizeBytesBefore = fs.statSync(dbPath).size;

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Pre-cleanup counts
  const totalRoutesBefore = (db.prepare('SELECT count(*) as count FROM routes').get() as { count: number }).count;
  const twoLegRoutesBefore = (db.prepare("SELECT count(*) as count FROM routes WHERE cycle_type = '2_LEG'").get() as { count: number }).count;
  const threeLegRoutesBefore = (db.prepare("SELECT count(*) as count FROM routes WHERE cycle_type = '3_LEG'").get() as { count: number }).count;

  const totalCandidatesBefore = (db.prepare('SELECT count(*) as count FROM candidates').get() as { count: number }).count;
  const twoLegCandidatesBefore = (db.prepare("SELECT count(*) as count FROM candidates WHERE cycle_type = '2_LEG'").get() as { count: number }).count;
  const threeLegCandidatesBefore = (db.prepare("SELECT count(*) as count FROM candidates WHERE cycle_type = '3_LEG' OR route_name LIKE '%(3-Leg Cycle)%'").get() as { count: number }).count;

  const verifiedPoolsBefore = (db.prepare('SELECT count(*) as count FROM verified_pools').get() as { count: number }).count;

  // Execute cleanup within transaction
  const cleanupTx = db.transaction(() => {
    // 1. Delete all 3-leg routes
    const routesResult = db.prepare("DELETE FROM routes WHERE cycle_type = '3_LEG'").run();
    
    // Also remove any routes where ordered_pool_ids length is not 2
    db.prepare(`
      DELETE FROM routes 
      WHERE route_id IN (
        SELECT route_id FROM routes WHERE cycle_type != '2_LEG'
      )
    `).run();

    // 2. Delete obsolete 3-leg candidate records
    const candidatesResult = db.prepare(`
      DELETE FROM candidates 
      WHERE cycle_type = '3_LEG' 
         OR route_name LIKE '%(3-Leg Cycle)%'
         OR cycle_type != '2_LEG'
    `).run();

    return {
      deletedRoutes: routesResult.changes,
      deletedCandidates: candidatesResult.changes
    };
  });

  const txResult = cleanupTx();

  // Post-cleanup counts
  const totalRoutesAfter = (db.prepare('SELECT count(*) as count FROM routes').get() as { count: number }).count;
  const twoLegRoutesAfter = (db.prepare("SELECT count(*) as count FROM routes WHERE cycle_type = '2_LEG'").get() as { count: number }).count;
  const threeLegRoutesAfter = (db.prepare("SELECT count(*) as count FROM routes WHERE cycle_type = '3_LEG'").get() as { count: number }).count;

  const totalCandidatesAfter = (db.prepare('SELECT count(*) as count FROM candidates').get() as { count: number }).count;
  const twoLegCandidatesAfter = (db.prepare("SELECT count(*) as count FROM candidates WHERE cycle_type = '2_LEG'").get() as { count: number }).count;
  const threeLegCandidatesAfter = (db.prepare("SELECT count(*) as count FROM candidates WHERE cycle_type = '3_LEG'").get() as { count: number }).count;

  const verifiedPoolsAfter = (db.prepare('SELECT count(*) as count FROM verified_pools').get() as { count: number }).count;

  // Checkpoint WAL and VACUUM to reclaim space
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();

  // Run VACUUM on separate connection to compact file
  const vacuumDb = new Database(dbPath);
  vacuumDb.exec('VACUUM;');
  vacuumDb.close();

  const fileSizeBytesAfter = fs.statSync(dbPath).size;

  const report: CleanupReport = {
    timestamp,
    dbPath,
    fileSizeBytesBefore,
    fileSizeBytesAfter,
    routesBefore: {
      total: totalRoutesBefore,
      twoLeg: twoLegRoutesBefore,
      threeLeg: threeLegRoutesBefore
    },
    routesAfter: {
      total: totalRoutesAfter,
      twoLeg: twoLegRoutesAfter,
      threeLeg: threeLegRoutesAfter
    },
    deletedRoutesCount: txResult.deletedRoutes,
    candidatesBefore: {
      total: totalCandidatesBefore,
      twoLeg: twoLegCandidatesBefore,
      threeLeg: threeLegCandidatesBefore
    },
    candidatesAfter: {
      total: totalCandidatesAfter,
      twoLeg: twoLegCandidatesAfter,
      threeLeg: threeLegCandidatesAfter
    },
    deletedCandidatesCount: txResult.deletedCandidates,
    verifiedPoolsBefore,
    verifiedPoolsAfter
  };

  return report;
}

// Direct execution
if (process.argv[1] && process.argv[1].endsWith('cleanup_3leg_routes.ts')) {
  const projectRoot = process.cwd();
  const dbPath = path.join(projectRoot, 'data/arbitrage.db');
  console.log(`[Cleanup] Starting permanent 3-leg route removal on: ${dbPath}`);
  const report = cleanupThreeLegDatabase(dbPath);
  console.log('[Cleanup] Completed. Report:');
  console.log(JSON.stringify(report, null, 2));
}
