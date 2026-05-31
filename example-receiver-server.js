/**
 * Example RECEIVING endpoint (runs on your server, NOT the Pi)
 * ------------------------------------------------------------
 * Receives hourly reports from the Pi logger and stores them in SQLite.
 * Computes per-period consumption from the cumulative energy_kwh counter.
 */

const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');

const app  = express();
const PORT = 4000;
const API_KEY = 'your-secret-key'; // must match config.json reportApiKey

app.use(express.json());

// ─── DATABASE ───────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'energy.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reported_at TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    device_name TEXT,
    online      INTEGER,
    power_w     REAL,
    voltage_v   REAL,
    current_a   REAL,
    energy_kwh  REAL
  );
  CREATE INDEX IF NOT EXISTS idx_device_time ON readings (device_id, reported_at);
`);

const insertReading = db.prepare(`
  INSERT INTO readings (reported_at, device_id, device_name, online, power_w, voltage_v, current_a, energy_kwh)
  VALUES (@reported_at, @device_id, @device_name, @online, @power_w, @voltage_v, @current_a, @energy_kwh)
`);

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── RECEIVE HOURLY REPORT ───────────────────────────────────────────────────
app.post('/api/energy-report', auth, (req, res) => {
  const { reportedAt, devices } = req.body;

  if (!Array.isArray(devices)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const insertMany = db.transaction((rows) => {
    for (const d of rows) {
      insertReading.run({
        reported_at: reportedAt,
        device_id:   d.id,
        device_name: d.name,
        online:      d.online ? 1 : 0,
        power_w:     d.power_w     ?? null,
        voltage_v:   d.voltage_v   ?? null,
        current_a:   d.current_a   ?? null,
        energy_kwh:  d.energy_kwh  ?? null,
      });
    }
  });

  insertMany(devices);
  console.log(`📥 Stored ${devices.length} readings @ ${reportedAt}`);
  res.json({ ok: true, stored: devices.length });
});

// ─── QUERY: consumption for a device over a period ───────────────────────────
// GET /api/consumption?deviceId=xxx&from=2026-05-01&to=2026-05-31
app.get('/api/consumption', (req, res) => {
  const { deviceId, from, to } = req.query;

  const rows = db.prepare(`
    SELECT reported_at, energy_kwh
    FROM readings
    WHERE device_id = ? AND online = 1
      AND reported_at >= ? AND reported_at <= ?
    ORDER BY reported_at ASC
  `).all(deviceId, from || '2000-01-01', to || '2100-01-01');

  if (rows.length < 2) {
    return res.json({ deviceId, consumed_kwh: 0, readings: rows.length });
  }

  // Consumption = last cumulative - first cumulative
  const consumed = rows[rows.length - 1].energy_kwh - rows[0].energy_kwh;

  res.json({
    deviceId,
    from: rows[0].reported_at,
    to:   rows[rows.length - 1].reported_at,
    consumed_kwh: parseFloat(consumed.toFixed(3)),
    readings: rows.length,
  });
});

// ─── QUERY: hourly breakdown ─────────────────────────────────────────────────
// GET /api/hourly?deviceId=xxx&date=2026-05-31
app.get('/api/hourly', (req, res) => {
  const { deviceId, date } = req.query;

  const rows = db.prepare(`
    SELECT reported_at, energy_kwh, power_w
    FROM readings
    WHERE device_id = ? AND online = 1
      AND reported_at LIKE ?
    ORDER BY reported_at ASC
  `).all(deviceId, `${date}%`);

  // Diff consecutive readings to get per-hour usage
  const hourly = [];
  for (let i = 1; i < rows.length; i++) {
    hourly.push({
      hour: rows[i].reported_at,
      kwh:  parseFloat((rows[i].energy_kwh - rows[i - 1].energy_kwh).toFixed(3)),
      avg_power_w: rows[i].power_w,
    });
  }

  res.json({ deviceId, date, hourly });
});

app.listen(PORT, () => {
  console.log(`📡 Energy receiver running on http://localhost:${PORT}`);
});
