import { createConnection } from '/home/ubuntu/whatsapp-commerce/node_modules/.pnpm/mysql2@3.15.1/node_modules/mysql2/promise.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('No DATABASE_URL');
const m = url.match(/mysql:\/\/([^:]+):([^@]+)@([^:\/]+):(\d+)\/([^?]+)/);
const [,user,pass,host,port,db] = m;

const conn = await createConnection({ host, port: parseInt(port), user, password: pass, database: db, ssl: {} });

const stmts = [
  `CREATE TABLE IF NOT EXISTS dataset_snapshots (id VARCHAR(36) PRIMARY KEY, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL, createdBy VARCHAR(128), label VARCHAR(256), totalImages INT NOT NULL, bboxImages INT NOT NULL, qualityImages INT NOT NULL, classStats JSON NOT NULL, notes TEXT)`,
  `CREATE TABLE IF NOT EXISTS model_ab_tests (id VARCHAR(36) PRIMARY KEY, modelName VARCHAR(128) NOT NULL, championVersion VARCHAR(128) NOT NULL, challengerVersion VARCHAR(128) NOT NULL, trafficSplitPct INT DEFAULT 20 NOT NULL, status VARCHAR(32) DEFAULT 'running' NOT NULL, championRequests INT DEFAULT 0 NOT NULL, challengerRequests INT DEFAULT 0 NOT NULL, championMetric FLOAT, challengerMetric FLOAT, pValue FLOAT, winner VARCHAR(32), startedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL, concludedAt TIMESTAMP NULL, notes TEXT)`,
  `CREATE INDEX IF NOT EXISTS ds_snap_created_idx ON dataset_snapshots (createdAt)`,
  `CREATE INDEX IF NOT EXISTS ab_model_idx ON model_ab_tests (modelName)`,
  `CREATE INDEX IF NOT EXISTS ab_status_idx ON model_ab_tests (status)`
];

for (const s of stmts) {
  try {
    await conn.execute(s);
    console.log('OK:', s.slice(0, 60));
  } catch (e) {
    if (e.code === 'ER_DUP_KEYNAME' || e.message?.includes('already exists') || e.message?.includes('Duplicate')) {
      console.log('SKIP (exists):', s.slice(0, 60));
    } else {
      throw e;
    }
  }
}
await conn.end();
console.log('Migration done');
