// ════════════════════════════════════════════════════════════════════════════
// HISTORY ENDPOINTS v2 — POWER-INTEGRATION METHOD
// ----------------------------------------------------------------------------
// Replaces the old add_ele diff approach (which was broken — add_ele on the
// Lasco plug is NOT a usable energy counter). Energy is computed as
// power_w / 1000 * hours, summed over readings, bucketed in PH time.
//
// Replace your existing /api/history/hourly and /api/history/daily routes
// with these. Add the helper block once near the top of the routes section.
// ════════════════════════════════════════════════════════════════════════════

const TZ_OFFSET_MS = 8 * 3600 * 1000; // Philippines UTC+8
const MAX_GAP_HOURS = 0.5;            // cap gaps so missing readings don't inflate totals

function phShift(iso) {
  return new Date(new Date(iso).getTime() + TZ_OFFSET_MS);
}
function phDateKey(iso) { return phShift(iso).toISOString().slice(0, 10); } // YYYY-MM-DD
function phHourKey(iso) { return phShift(iso).toISOString().slice(11, 13); } // HH

// Given ordered rows [{ts, power_w}], return kWh for the interval each row
// represents (time until the next row, capped). Returns array of {ts, kwh}.
function perReadingKwh(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i], next = rows[i + 1];
    let hours = 1 / 12; // default 5 min
    if (next) {
      const dt = (new Date(next.ts) - new Date(cur.ts)) / 3600000;
      hours = Math.min(Math.max(dt, 0), MAX_GAP_HOURS);
    }
    out.push({ ts: cur.ts, kwh: (cur.power_w / 1000) * hours });
  }
  return out;
}

// HISTORY: hourly kWh for a device on a given PH-local date
// GET /api/history/hourly?deviceId=xxx&date=2026-06-20
app.get('/api/history/hourly', (req, res) => {
  const { deviceId, date } = req.query;
  if (!deviceId || !date) return res.status(400).json({ error: 'deviceId and date required' });

  // PH day spans into adjacent UTC days — pull a window with margin
  const dayStart = new Date(`${date}T00:00:00+08:00`).toISOString();
  const dayEnd   = new Date(`${date}T23:59:59+08:00`).toISOString();

  const rows = db.prepare(`
    SELECT ts, power_w FROM readings
    WHERE device_id = ? AND online = 1
      AND ts >= datetime(?, '-1 hours') AND ts <= datetime(?, '+1 hours')
    ORDER BY ts ASC
  `).all(deviceId, dayStart, dayEnd);

  const kwhRows = perReadingKwh(rows);

  // Sum into PH hour buckets, but only for readings that fall on this PH date
  const byHour = {};
  for (const r of kwhRows) {
    if (phDateKey(r.ts) !== date) continue;
    const h = phHourKey(r.ts);
    byHour[h] = (byHour[h] || 0) + r.kwh;
  }

  // Build 00:00–23:00 series (include zero hours for a complete chart)
  const series = [];
  for (let h = 0; h < 24; h++) {
    const key = String(h).padStart(2, '0');
    series.push({ hour: `${key}:00`, kwh: parseFloat((byHour[key] || 0).toFixed(3)) });
  }

  res.json({ deviceId, date, series, rate: RATE });
});

// HISTORY: daily kWh over a range, bucketed in PH time
// GET /api/history/daily?deviceId=xxx&days=14
app.get('/api/history/daily', (req, res) => {
  const { deviceId, days = 14 } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const since = new Date(Date.now() - Number(days) * 86400000).toISOString();

  const rows = db.prepare(`
    SELECT ts, power_w FROM readings
    WHERE device_id = ? AND online = 1 AND ts >= ?
    ORDER BY ts ASC
  `).all(deviceId, since);

  const kwhRows = perReadingKwh(rows);

  const byDay = {};
  for (const r of kwhRows) {
    const day = phDateKey(r.ts);
    byDay[day] = (byDay[day] || 0) + r.kwh;
  }

  const series = Object.keys(byDay).sort().map(day => ({
    day,
    kwh: parseFloat(byDay[day].toFixed(3)),
  }));

  res.json({ deviceId, series, rate: RATE });
});