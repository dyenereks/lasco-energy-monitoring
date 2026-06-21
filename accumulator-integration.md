# Energy Accumulator — Integration Guide

This adds a **continuous power-integration accumulator** that computes the most
accurate possible daily kWh from your hardware: it integrates power into a running
daily total the moment each reading is polled, persists it across restarts, and
rolls over at Philippine midnight.

## Files
- `energy-accumulator.js` — the module (drop into your project folder)

## Step 1 — Import and initialise (top of index.js)

After your `const db = new Database(...)` line, add:

```js
const { createAccumulator } = require('./energy-accumulator');
const accumulator = createAccumulator(db);
```

## Step 2 — Feed every reading into the accumulator

In `readAllDevices()`, right after you build each `reading`, record it.
Find the loop that pushes readings and add the `accumulator.record(...)` call:

```js
async function readAllDevices() {
  const results = [];
  for (const dev of DEVICES) {
    const reading = await readDevice(dev);
    accumulator.record(reading);   // <-- ADD THIS LINE
    results.push(reading);
    console.log(`  ${reading.online ? 'OK' : 'XX'} ${reading.name}: ` +
      (reading.online ? `${reading.power_w}W | ${reading.energy_kwh}kWh` : reading.error));
  }
  lastReadings = results;
  lastPollTime = new Date().toISOString();
  return results;
}
```

That's it for capturing. Now every poll (live dashboard refresh, 5-min log job,
and hourly report) contributes to the accurate running total.

## Step 3 — Add an endpoint to read accurate daily totals

Add this route alongside your other `/api/...` routes:

```js
// Accurate daily totals from the live accumulator (PH time)
// GET /api/energy/daily?deviceId=xxx&days=14
app.get('/api/energy/daily', (req, res) => {
  const { deviceId, days = 14 } = req.query;
  const { phDateKey } = require('./energy-accumulator');

  // Build list of the last N PH days
  const wanted = [];
  for (let i = Number(days) - 1; i >= 0; i--) {
    wanted.push(phDateKey(new Date(Date.now() - i * 86400000)));
  }

  let rows;
  if (deviceId) {
    rows = db.prepare(
      `SELECT day, kwh FROM daily_energy WHERE device_id = ? AND day >= ? ORDER BY day ASC`
    ).all(deviceId, wanted[0]);
  } else {
    rows = db.prepare(
      `SELECT day, SUM(kwh) as kwh FROM daily_energy WHERE day >= ? GROUP BY day ORDER BY day ASC`
    ).all(wanted[0]);
  }

  const map = Object.fromEntries(rows.map(r => [r.day, r.kwh]));
  const series = wanted.map(day => ({
    day,
    kwh: parseFloat((map[day] || 0).toFixed(3)),
  }));

  res.json({ deviceId: deviceId || 'all', series, rate: RATE });
});

// Today's accurate kWh so far (for the live dashboard summary)
// GET /api/energy/today?deviceId=xxx
app.get('/api/energy/today', (req, res) => {
  const { deviceId } = req.query;
  const { phDateKey } = require('./energy-accumulator');
  const today = phDateKey();

  let row;
  if (deviceId) {
    row = db.prepare(`SELECT kwh FROM daily_energy WHERE day = ? AND device_id = ?`).get(today, deviceId);
  } else {
    row = db.prepare(`SELECT SUM(kwh) as kwh FROM daily_energy WHERE day = ?`).get(today);
  }

  const kwh = row && row.kwh ? row.kwh : 0;
  res.json({ day: today, kwh: parseFloat(kwh.toFixed(3)), cost: parseFloat((kwh * RATE).toFixed(2)), rate: RATE });
});
```

## Step 4 — Restart

```bash
sudo systemctl restart lasco-logger
```

## How accurate is this now?

- Every poll contributes using the **actual elapsed time** since that device's
  previous poll — not a fixed assumption.
- Drop `logIntervalMinutes` to 1 or 2 in config.json and accuracy rises
  automatically with no other change, because intervals get shorter.
- Gaps (Pi offline, device unreachable) are capped at 30 min so an outage can't
  inflate the total — it just under-counts that gap slightly, same as SmartLife
  would when the device is unplugged.

## Old vs new endpoints

- Old `/api/history/daily` (DB power-integration after the fact) still works and
  will closely agree with this. The new `/api/energy/daily` is the authoritative,
  always-current one. You can point the dashboard chart at the new endpoint.

## Note on existing data

The accumulator only starts totalling from the moment you deploy it. To
back-fill `daily_energy` from your existing `readings` history, run the
one-time backfill script (backfill-accumulator.js) described below.
