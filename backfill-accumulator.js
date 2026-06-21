/**
 * backfill-accumulator.js  (run once)
 * ─────────────────────────────────────────────────────────────────────────────
 * Populates the daily_energy table from your existing `readings` history using
 * the same power-integration method the live accumulator uses. Safe to re-run;
 * it recomputes and overwrites daily_energy for every day found in readings.
 *
 *   node backfill-accumulator.js
 */

const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, 'energy.db'));

const TZ_OFFSET_MS = 8 * 3600 * 1000; // UTC+8
const MAX_GAP_HOURS = 0.5;

function phDateKey(iso) {
  return new Date(new Date(iso).getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_energy (
    day        TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    device_name TEXT,
    kwh        REAL NOT NULL DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (day, device_id)
  );
`);

// Get every device that appears in readings
const devices = db.prepare(`
  SELECT DISTINCT device_id, device_name FROM readings
`).all();

const upsert = db.prepare(`
  INSERT INTO daily_energy (day, device_id, device_name, kwh, updated_at)
  VALUES (@day, @device_id, @device_name, @kwh, @updated_at)
  ON CONFLICT(day, device_id) DO UPDATE SET
    kwh = @kwh, device_name = @device_name, updated_at = @updated_at
`);

let totalDays = 0;

for (const dev of devices) {
  const rows = db.prepare(`
    SELECT ts, power_w FROM readings
    WHERE device_id = ? AND online = 1
    ORDER BY ts ASC
  `).all(dev.device_id);

  const byDay = {};
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i], next = rows[i + 1];
    let hours = 1 / 12;
    if (next) {
      const dt = (new Date(next.ts) - new Date(cur.ts)) / 3600000;
      hours = Math.min(Math.max(dt, 0), MAX_GAP_HOURS);
    }
    const kwh = (cur.power_w / 1000) * hours;
    const day = phDateKey(cur.ts);
    byDay[day] = (byDay[day] || 0) + kwh;
  }

  const tx = db.transaction(() => {
    for (const [day, kwh] of Object.entries(byDay)) {
      upsert.run({
        day,
        device_id:   dev.device_id,
        device_name: dev.device_name,
        kwh,
        updated_at:  new Date().toISOString(),
      });
      totalDays++;
    }
  });
  tx();

  console.log(`Backfilled ${Object.keys(byDay).length} days for ${dev.device_name || dev.device_id}`);
}

console.log(`\nDone. ${totalDays} device-days written to daily_energy.`);
console.log('Verify with:  node -e "const d=require(\'better-sqlite3\')(\'energy.db\');console.table(d.prepare(\'SELECT * FROM daily_energy ORDER BY day DESC LIMIT 20\').all())"');
