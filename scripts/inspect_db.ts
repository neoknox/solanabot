import Database from 'better-sqlite3';

function check(dbPath: string) {
  console.log(`\n=== CHECKING DB: ${dbPath} ===`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables:', tables.map((t: any) => t.name));
    for (const t of tables as any[]) {
      try {
        const c = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as any;
        console.log(`  Table ${t.name}: ${c.c} rows`);
      } catch (e: any) {
        console.log(`  Table ${t.name}: error ${e.message}`);
      }
    }
  } catch (err: any) {
    console.error('Query error:', err.message);
  } finally {
    db.close();
  }
}

check('C:/Users/HP/solanabot/data/arbitrage_scanner.db');
check('C:/Users/HP/.gemini/antigravity/scratch/solana-arbitrage-bot/data/arbitrage_scanner.db');
