import Database from 'better-sqlite3';

const db = new Database('C:/Users/HP/solanabot/data/arbitrage_scanner.db', { readonly: true });
const schema = db.prepare("PRAGMA table_info('routes')").all();
console.log('Routes table schema:', schema.map((c: any) => `${c.name} (${c.type})`));

const sample = db.prepare('SELECT * FROM routes LIMIT 3').all();
console.log('Sample routes:', sample);

const count2Leg = db.prepare("SELECT COUNT(*) as c FROM routes WHERE cycle_type = '2_LEG'").get() as any;
const count3Leg = db.prepare("SELECT COUNT(*) as c FROM routes WHERE cycle_type = '3_LEG'").get() as any;
console.log(`2-leg routes: ${count2Leg.c}, 3-leg routes: ${count3Leg.c}`);

db.close();
