/**
 * Lasco Energy Logger + Local Dashboard with History — Raspberry Pi edition
 * --------------------------------------------------------------------------
 * 1. Polls Lasco/Tuya devices over the LOCAL network (free, no cloud)
 * 2. Stores every reading in a local SQLite DB (for history/charts)
 * 3. POSTs an hourly energy report to a remote endpoint
 * 4. Serves a local web dashboard with live data + historical charts
 */

const TuyAPI   = require('tuyapi');
const axios    = require('axios');
const express  = require('express');
const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');
const cron     = require('node-cron');

// ─── LOAD CONFIG ────────────────────────────────────────────────────────────
const config   = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const DEVICES   = config.devices;
const ENDPOINT  = config.reportEndpoint;
const API_KEY   = config.reportApiKey;
const RATE      = config.ratePerKwh || 9.0;
const WEB_PORT  = config.webPort || 3000;
const LOG_EVERY = config.logIntervalMinutes || 5;   // how often to record to DB

// ─── DPS CODE MAP (Lasco Dual Aircon Plug) ──────────────────────────────────
const DPS = {
  switch1: '1',
  switch2: '2',
  current: '18',   // mA
  power:   '19',   // W x10
  voltage: '20',   // V x10
  energy:  '26',   // kWh x100 (cumulative add_ele)
};

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'energy.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    device_name TEXT,
    online      INTEGER,
    power_w     REAL,
    voltage_v   REAL,
    current_a   REAL,
    energy_kwh  REAL
  );
  CREATE INDEX IF NOT EXISTS idx_dev_ts ON readings (device_id, ts);
`);

const insertReading = db.prepare(`
  INSERT INTO readings (ts, device_id, device_name, online, power_w, voltage_v, current_a, energy_kwh)
  VALUES (@ts, @device_id, @device_name, @online, @power_w, @voltage_v, @current_a, @energy_kwh)
`);

function storeReadings(readings) {
  const tx = db.transaction((rows) => {
    for (const d of rows) {
      insertReading.run({
        ts:          d.timestamp,
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
  tx(readings);
}

// ─── IN-MEMORY STATE ──────────────────────────────────────────────────────────
let lastReadings = [];
let lastPollTime = null;
let lastReportStatus = 'pending';

// ─── READ A SINGLE DEVICE LOCALLY ───────────────────────────────────────────
async function readDevice(deviceCfg) {
  const device = new TuyAPI({
    id:      deviceCfg.id,
    key:     deviceCfg.key,
    ip:      deviceCfg.ip,
    version: deviceCfg.version || '3.4',
    issueGetOnConnect: true,
  });

  try {
    await device.find();
    await device.connect();
    const data = await device.get({ schema: true });
    device.disconnect();

    const dps = data.dps || {};
    return {
      id:         deviceCfg.id,
      name:       deviceCfg.name,
      online:     true,
      switch1:    dps[DPS.switch1] ?? false,
      switch2:    dps[DPS.switch2] ?? false,
      power_w:    (dps[DPS.power]   ?? 0) / 10,
      voltage_v:  (dps[DPS.voltage] ?? 0) / 10,
      current_a:  (dps[DPS.current] ?? 0) / 1000,
      energy_kwh: (dps[DPS.energy]  ?? 0) / 100,
      timestamp:  new Date().toISOString(),
    };
  } catch (err) {
    device.disconnect();
    return {
      id:        deviceCfg.id,
      name:      deviceCfg.name,
      online:    false,
      error:     err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

async function readAllDevices() {
  const results = [];
  for (const dev of DEVICES) {
    const reading = await readDevice(dev);
    results.push(reading);
    console.log(`  ${reading.online ? 'OK' : 'XX'} ${reading.name}: ` +
      (reading.online ? `${reading.power_w}W | ${reading.energy_kwh}kWh` : reading.error));
  }
  lastReadings = results;
  lastPollTime = new Date().toISOString();
  return results;
}

// ─── REMOTE REPORT ──────────────────────────────────────────────────────────
function saveLocalBackup(report) {
  fs.appendFileSync(path.join(__dirname, 'backup-log.jsonl'), JSON.stringify(report) + '\n');
}

async function sendReport(readings) {
  const report = { reportedAt: new Date().toISOString(), ratePerKwh: RATE, devices: readings };
  saveLocalBackup(report);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
    const res = await axios.post(ENDPOINT, report, { headers, timeout: 15000 });
    console.log(`Report sent -> ${res.status} ${res.statusText}`);
    lastReportStatus = `sent (${res.status}) @ ${new Date().toLocaleTimeString()}`;
    return true;
  } catch (err) {
    console.error(`Failed to send report: ${err.message} (saved to backup)`);
    lastReportStatus = `failed @ ${new Date().toLocaleTimeString()} - ${err.message}`;
    return false;
  }
}

// ─── JOBS ──────────────────────────────────────────────────────────────────
// Frequent DB logging (every LOG_EVERY minutes) — builds history
async function logJob() {
  console.log(`\n[${new Date().toLocaleString()}] Logging readings to DB...`);
  const readings = await readAllDevices();
  storeReadings(readings);
}

// Hourly remote report
async function reportJob() {
  console.log(`\n[${new Date().toLocaleString()}] Hourly remote report...`);
  const readings = await readAllDevices();
  storeReadings(readings);
  await sendReport(readings);
}

// ─── WEB DASHBOARD ────────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Live data (re-polls on demand)
app.get('/api/live', async (req, res) => {
  try {
    const readings = await readAllDevices();
    const plugs       = readings.filter(d => d.online);
    const totalPower  = plugs.reduce((s, d) => s + (d.power_w || 0), 0);
    const totalEnergy = plugs.reduce((s, d) => s + (d.energy_kwh || 0), 0);

    res.json({
      devices: readings,
      summary: {
        totalPower:   totalPower.toFixed(1),
        totalEnergy:  totalEnergy.toFixed(3),
        totalCost:    (totalEnergy * RATE).toFixed(2),
        onlineCount:  readings.filter(d => d.online).length,
        totalCount:   readings.length,
        ratePerKwh:   RATE,
        reportStatus: lastReportStatus,
        updatedAt:    lastPollTime,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List devices (for the chart selector)
app.get('/api/devices', (req, res) => {
  res.json(DEVICES.map(d => ({ id: d.id, name: d.name })));
});

// HISTORY: hourly kWh usage for a given device + date
// GET /api/history/hourly?deviceId=xxx&date=2026-05-31
app.get('/api/history/hourly', (req, res) => {
  const { deviceId, date } = req.query;
  if (!deviceId || !date) return res.status(400).json({ error: 'deviceId and date required' });

  // Get all readings for that day, ordered
  const rows = db.prepare(`
    SELECT ts, energy_kwh FROM readings
    WHERE device_id = ? AND online = 1 AND ts LIKE ?
    ORDER BY ts ASC
  `).all(deviceId, `${date}%`);

  // Bucket by hour, take the last cumulative reading in each hour
  const byHour = {};
  for (const r of rows) {
    const hour = r.ts.slice(11, 13); // "HH"
    byHour[hour] = r.energy_kwh;      // last value wins
  }

  // Build 0–23 series; usage = diff from previous hour's cumulative
  const hours = Object.keys(byHour).sort();
  const series = [];
  let prev = null;
  for (const h of hours) {
    const cumulative = byHour[h];
    if (prev !== null) {
      series.push({ hour: `${h}:00`, kwh: parseFloat((cumulative - prev).toFixed(3)) });
    }
    prev = cumulative;
  }

  res.json({ deviceId, date, series, rate: RATE });
});

// HISTORY: daily kWh usage over a date range
// GET /api/history/daily?deviceId=xxx&days=14
app.get('/api/history/daily', (req, res) => {
  const { deviceId, days = 14 } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const since = new Date(Date.now() - days * 86400000).toISOString();

  const rows = db.prepare(`
    SELECT ts, energy_kwh FROM readings
    WHERE device_id = ? AND online = 1 AND ts >= ?
    ORDER BY ts ASC
  `).all(deviceId, since);

  // Last cumulative reading per day
  const byDay = {};
  for (const r of rows) {
    const day = r.ts.slice(0, 10); // "YYYY-MM-DD"
    byDay[day] = r.energy_kwh;
  }

  // Daily usage = diff between consecutive days' last cumulative
  const daysSorted = Object.keys(byDay).sort();
  const series = [];
  let prev = null;
  for (const day of daysSorted) {
    const cumulative = byDay[day];
    if (prev !== null) {
      series.push({ day, kwh: parseFloat((cumulative - prev).toFixed(3)) });
    }
    prev = cumulative;
  }

  res.json({ deviceId, series, rate: RATE });
});

// CSV EXPORT: raw readings
// GET /api/export?deviceId=xxx&days=30  (deviceId optional = all devices)
app.get('/api/export', (req, res) => {
  const { deviceId, days = 30 } = req.query;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let rows;
  if (deviceId) {
    rows = db.prepare(`
      SELECT ts, device_id, device_name, online, power_w, voltage_v, current_a, energy_kwh
      FROM readings WHERE device_id = ? AND ts >= ? ORDER BY ts ASC
    `).all(deviceId, since);
  } else {
    rows = db.prepare(`
      SELECT ts, device_id, device_name, online, power_w, voltage_v, current_a, energy_kwh
      FROM readings WHERE ts >= ? ORDER BY ts ASC
    `).all(since);
  }

  const header = 'timestamp,device_id,device_name,online,power_w,voltage_v,current_a,energy_kwh';
  const lines = rows.map(r => {
    const name = `"${(r.device_name || '').replace(/"/g, '""')}"`;
    return [r.ts, r.device_id, name, r.online, r.power_w, r.voltage_v, r.current_a, r.energy_kwh].join(',');
  });
  const csv = [header, ...lines].join('\n');

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="lasco-energy-${stamp}.csv"`);
  res.send(csv);
});

app.listen(WEB_PORT, () => {
  console.log(`Local dashboard: http://localhost:${WEB_PORT}`);
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
console.log('Lasco Energy Logger + Dashboard + History started');
console.log(`   Devices:    ${DEVICES.length}`);
console.log(`   Endpoint:   ${ENDPOINT}`);
console.log(`   DB logging: every ${LOG_EVERY} min`);
console.log(`   Reporting:  hourly`);
console.log(`   Dashboard:  port ${WEB_PORT}\n`);

logJob(); // run once at startup

cron.schedule(`*/${LOG_EVERY} * * * *`, logJob);  // frequent DB logging
cron.schedule('0 * * * *', reportJob);            // hourly remote report
