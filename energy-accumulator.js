/**
 * energy-accumulator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Continuous power-integration energy accumulator with persistence.
 *
 * Instead of reconstructing energy from the DB afterward, this integrates power
 * into a running per-device, per-PH-day kWh total the moment each reading is
 * polled. It persists totals to a small table so they survive restarts, and
 * rolls over cleanly at Philippine midnight.
 *
 * Accuracy: every poll contributes (power_w/1000 * elapsed_hours) using the
 * ACTUAL elapsed time since that device's previous poll (capped to avoid gaps
 * inflating totals). Shorter poll intervals => higher accuracy automatically.
 */

const TZ_OFFSET_MS = 8 * 3600 * 1000; // Philippines UTC+8
const MAX_GAP_HOURS = 0.5;            // cap elapsed time so outages don't inflate

function phDateKey(date = new Date()) {
  return new Date(date.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function createAccumulator(db) {
  // Persistent daily totals (survives restart)
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_energy (
      day        TEXT NOT NULL,          -- PH date YYYY-MM-DD
      device_id  TEXT NOT NULL,
      device_name TEXT,
      kwh        REAL NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (day, device_id)
    );
  `);

  const upsert = db.prepare(`
    INSERT INTO daily_energy (day, device_id, device_name, kwh, updated_at)
    VALUES (@day, @device_id, @device_name, @kwh, @updated_at)
    ON CONFLICT(day, device_id) DO UPDATE SET
      kwh = @kwh, device_name = @device_name, updated_at = @updated_at
  `);

  const getDay = db.prepare(`SELECT kwh FROM daily_energy WHERE day = ? AND device_id = ?`);

  // In-memory: last poll time per device (to measure elapsed)
  const lastPoll = {}; // device_id -> { ts: Date }

  /**
   * Record one reading. Call this every time a device is polled.
   * @param {object} reading - { id, name, online, power_w, timestamp }
   */
  function record(reading) {
    if (!reading.online || typeof reading.power_w !== 'number') {
      // Still advance the clock so the next interval isn't double-counted
      lastPoll[reading.id] = { ts: new Date(reading.timestamp) };
      return;
    }

    const now = new Date(reading.timestamp);
    const prev = lastPoll[reading.id];
    lastPoll[reading.id] = { ts: now };

    // First reading after start: no interval to integrate yet
    if (!prev) return;

    let elapsedH = (now - prev.ts) / 3600000;
    if (elapsedH <= 0) return;
    elapsedH = Math.min(elapsedH, MAX_GAP_HOURS);

    const kwhDelta = (reading.power_w / 1000) * elapsedH;
    const day = phDateKey(now);

    const row = getDay.get(day, reading.id);
    const newKwh = (row ? row.kwh : 0) + kwhDelta;

    upsert.run({
      day,
      device_id:   reading.id,
      device_name: reading.name,
      kwh:         newKwh,
      updated_at:  now.toISOString(),
    });
  }

  return { record, phDateKey };
}

module.exports = { createAccumulator, phDateKey };
