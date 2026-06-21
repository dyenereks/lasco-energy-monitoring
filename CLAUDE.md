# CLAUDE.md

Guidance for Claude (and humans) working on this repo.

## What this project is

A self-hosted energy monitor for **Lasco smart devices** (which run on the **Tuya**
platform) that runs on a **Raspberry Pi**. It:

1. Polls devices over the **local network** (free — no Tuya cloud subscription),
2. Logs readings to a local **SQLite** database (`energy.db`),
3. Maintains an accurate **continuous power-integration** energy total,
4. POSTs an **hourly report** to a remote endpoint,
5. Serves a **local web dashboard** with live data, hourly/daily charts, and CSV export.

Hardware in use: Raspberry Pi 3B, Lasco Wifi Dual Aircon Plug, Lasco 15W Wifi Bulb.
Location/timezone: **Philippines (UTC+8)**. Electricity provider: **LEYECO II**
(residential rate ~₱9.0/kWh as of mid-2026; configurable).

## Architecture

```
Lasco device (LAN) ──poll via tuyapi──> Pi (index.js)
                                          ├─ SQLite (energy.db): readings + daily_energy
                                          ├─ continuous accumulator (most accurate kWh)
                                          ├─ hourly POST ──> remote endpoint
                                          └─ Express dashboard (port 3000)
```

## Key files

| File | Purpose |
|---|---|
| `index.js` | Main app: polling, logging, hourly report, dashboard server |
| `energy-accumulator.js` | Continuous power-integration accumulator (per-device, per-PH-day) |
| `backfill-accumulator.js` | One-time: populate `daily_energy` from existing `readings` |
| `public/index.html` | Dashboard UI (live cards + Chart.js history + CSV export) |
| `config.json` | Local config (NOT committed — see config.example.json) |
| `config.example.json` | Config template |
| `lasco-logger.service` | systemd unit for 24/7 auto-start |
| `example-receiver-server.js` | Reference implementation of the remote endpoint |
| `energy.db` | SQLite data (NOT committed) |

## Hard-won facts — READ BEFORE CHANGING ENERGY LOGIC

These were discovered through painful debugging. Do not regress them.

### 1. `add_ele` (DPS 26) is NOT a usable energy counter
On the Lasco Dual Aircon Plug, the `add_ele` value **fluctuates up and down** and
has no consistent relationship to actual consumption. It is NOT cumulative kWh.
**Do not** compute energy by diffing `add_ele`. Early versions did this and were
badly wrong (off by 2-3x, sometimes inverted).

### 2. Energy MUST be computed from power integration
Correct method: for each reading, `kWh = power_w / 1000 * elapsed_hours`, summed.
- `elapsed_hours` = actual time since that device's previous poll (not a fixed assumption)
- Cap elapsed at **0.5h** (`MAX_GAP_HOURS`) so outages don't inflate totals
- This method was verified to match the SmartLife app within ~5-12%.

### 3. Everything is bucketed in Philippine time (UTC+8)
Readings are stored as UTC ISO strings (`toISOString()`). SmartLife groups days
in PH local time. **Always shift by +8h before bucketing into days/hours**, or
daily totals will be offset by 8 hours and won't match SmartLife.
Constant: `TZ_OFFSET_MS = 8 * 3600 * 1000`.

### 4. The small residual difference vs SmartLife is expected
Our numbers run slightly higher because we sample power discretely and assume it
holds across the interval (aircon compressors cycle). Shorter `logIntervalMinutes`
reduces this. Do not "fix" it with fudge factors.

## Tuya / Lasco connection facts

- Lasco App is a **Tuya OEM app** — devices can also be controlled via Smart Life,
  but accounts are separate namespaces (devices don't auto-sync between apps).
- Local access uses **tuyapi** with each device's `id`, `key` (local key), `ip`,
  and protocol `version` (these come from `tinytuya wizard`, saved in devices.json).
- Only **one local connection at a time** per device — keep the Smart Life / Lasco
  app closed while polling.
- Cloud API (only needed for initial key retrieval) facts:
  - PH accounts created before 2025-06-03 historically mapped to Western America,
    but the platform now routes PH through the **Singapore data center**.
  - The Singapore OpenAPI endpoint is **`https://openapi-sg.iotbing.com`**
    (NOT `openapi.tuyasg.com`, which does not resolve).
  - The official `@tuya/tuya-connector-nodejs` SDK signing did NOT work against the
    `iotbing.com` endpoint — manual HMAC-SHA256 signing was required.
- DPS code map for the Dual Aircon Plug:
  `1`=switch1, `2`=switch2, `18`=current(mA), `19`=power(W×10),
  `20`=voltage(V×10), `26`=add_ele (UNRELIABLE — see above).

## Device data scaling (cloud `/status` codes)
- `cur_power` ÷ 10 = Watts
- `cur_voltage` ÷ 10 = Volts
- `cur_current` ÷ 10 = Amps (local DPS 18 is mA, ÷ 1000)

## Config (config.json)

```json
{
  "reportEndpoint": "https://your-server.com/api/energy-report",
  "reportApiKey": "secret",
  "ratePerKwh": 9.0,
  "webPort": 3000,
  "logIntervalMinutes": 5,
  "devices": [
    { "name": "...", "id": "...", "key": "...", "ip": "...", "version": "3.4" }
  ]
}
```
- Lower `logIntervalMinutes` (e.g. 1-2) for higher energy accuracy.
- `config.json`, `energy.db`, `node_modules`, `*.log`, `backup-log.jsonl`
  must be gitignored.

## Common commands

```bash
# Run locally
npm install && node index.js

# On the Pi (deploy)
git pull
npm install
sudo systemctl restart lasco-logger

# Logs
sudo systemctl status lasco-logger
tail -f ~/lasco-pi-logger/logger.log

# One-time backfill of accumulator from existing readings
node backfill-accumulator.js

# Inspect DB (sqlite3 CLI not installed by default; use node or apt-get install sqlite3)
node -e "const d=require('better-sqlite3')('energy.db');console.table(d.prepare('SELECT * FROM daily_energy ORDER BY day DESC LIMIT 14').all())"
```

## API endpoints

- `GET /api/live` — re-polls devices, returns live readings + summary
- `GET /api/devices` — device list (for chart selector)
- `GET /api/history/hourly?deviceId=&date=` — hourly kWh (power-integration, PH time)
- `GET /api/history/daily?deviceId=&days=` — daily kWh (power-integration, PH time)
- `GET /api/energy/daily?deviceId=&days=` — daily kWh from the live accumulator (authoritative)
- `GET /api/energy/today?deviceId=` — today's accurate kWh + cost so far
- `GET /api/export?deviceId=&days=` — CSV of raw readings

## Gotchas

- `better-sqlite3` compiles native code; on a fresh Pi run
  `sudo apt-get install -y python3 build-essential` before `npm install`.
- Give devices a **DHCP reservation** in the router so their IPs stay fixed —
  local polling breaks if a device IP changes.
- The energy bulb has no power-metering DPS; only the plug reports power.

## Conventions

- Keep timezone handling centralized (always +8h shift helper). Don't sprinkle
  ad-hoc date math.
- Don't reintroduce `add_ele`-based energy math.
- Prefer extending the accumulator over recomputing from `readings` at request time.