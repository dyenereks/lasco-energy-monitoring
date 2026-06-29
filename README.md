# Lasco Energy Logger — Raspberry Pi Setup

Polls your Lasco/Tuya devices over your **local WiFi** (no Tuya cloud subscription needed),
logs every reading to a **local SQLite database** for history, POSTs an hourly energy report
to a remote endpoint of your choice, **and** serves a local web dashboard with live data plus
**hourly/daily usage charts**.

---

## 📦 What's in this project

| File | Purpose |
|---|---|
| `index.js` | Main app — polls locally, logs to SQLite, hourly reports, serves dashboard |
| `public/index.html` | Local dashboard with live data + history charts |
| `config.json` | Your device list + endpoint settings (you create this) |
| `config.example.json` | Template to copy |
| `package.json` | Dependencies |
| `lasco-logger.service` | systemd service so it auto-starts and stays running |
| `energy.db` | SQLite history database (auto-created on first run) |
| `firebase-sync.js` | Optional cloud mirror → Firestore (history) + Realtime DB (live) |

> ☁️ **Want the data on an online dashboard?** See [FIREBASE.md](FIREBASE.md) to mirror
> recorded readings to **Firestore** and the live snapshot to **Realtime Database**.
> It's opt-in — disabled by default.

---

## ✅ Prerequisites

- Raspberry Pi (any model) with Raspberry Pi OS
- Pi connected to the **same WiFi network** as your Lasco devices
- Your device `id`, `key`, and `ip` (from the `devices.json` that TinyTuya generated earlier)

> ⚠️ **Important:** The Pi must be on the same local network as the devices. Local mode
> does NOT work over the internet — that's the trade-off for it being free.

---

## 🔧 Step 1 — Install Node.js on the Pi

SSH into your Pi, then:

```bash
# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node -v   # should show v20.x
npm -v
```

---

## 🔧 Step 2 — Copy the project to your Pi

```bash
# On the Pi, in your home folder
cd ~
mkdir lasco-pi-logger
cd lasco-pi-logger

# Copy index.js, package.json, config.example.json into this folder
# (use scp, git, or a USB drive)
```

Install dependencies:

```bash
npm install
```

> ⚠️ **Note about `better-sqlite3`:** this package compiles native code during install.
> On Raspberry Pi it needs build tools. If `npm install` fails, run:
> ```bash
> sudo apt-get install -y python3 build-essential
> npm install
> ```
> The first install may take a few minutes on a Pi while it compiles — this is normal.

---

## 🔧 Step 3 — Create your config

```bash
cp config.example.json config.json
nano config.json
```

Fill it in with your real values:

```json
{
  "reportEndpoint": "https://your-server.com/api/energy-report",
  "reportApiKey": "your-secret-key",
  "ratePerKwh": 9.0,
  "devices": [
    {
      "name": "Lasco Wifi Dual Aircon Plug",
      "id": "a3f14816c0d9f9d5d3xxxx",
      "key": "3|2W}yIaxy6nUxxxx",
      "ip": "192.168.68.100",
      "version": "3.4"
    }
  ]
}
```

- `id` and `key` → from your `devices.json` (TinyTuya output)
- `ip` → your device's local IP (also in `devices.json`)
- `version` → protocol version, usually `3.4` (also in `devices.json` as `ver`)
- `reportEndpoint` → where you want the hourly JSON POSTed

Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`.

---

## 🔧 Step 4 — Test it manually

```bash
node index.js
```

You should see:
```
⚡ Lasco Energy Logger started
🔄 [date] Polling devices...
  ✅ Lasco Wifi Dual Aircon Plug: 745W | 12.34kWh
📤 Report sent → 200 OK
```

Press `Ctrl+C` to stop the test.

> If a device shows ❌, double-check its `ip`, `key`, and `version` in config.json.
> Also make sure the Smart Life / Lasco app is CLOSED — Tuya devices allow only one
> local connection at a time.

---

## 🔧 Step 5 — Run it 24/7 with systemd

This makes the logger start on boot and restart if it crashes.

```bash
# Copy the service file (edit User/paths if your username isn't "pi")
sudo cp lasco-logger.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable on boot + start now
sudo systemctl enable lasco-logger
sudo systemctl start lasco-logger
```

Check it's running:

```bash
sudo systemctl status lasco-logger
```

View live logs:

```bash
tail -f ~/lasco-pi-logger/logger.log
```

---

## 📊 Accessing the local dashboard

Once the logger is running, open a browser on any device on the same network:

```
http://<your-pi-ip>:3000
```

To find your Pi's IP:
```bash
hostname -I
```

The dashboard shows:
- **Live section:** power, voltage, current, and cumulative kWh per device, total power and cost, socket states, and the status of the last hourly report. Auto-refreshes every 30 seconds.
- **Usage History section:** pick a device and switch between **Hourly** (choose a date) and **Daily** (last 7/14/30 days) bar charts of kWh consumed, with total kWh, estimated cost, and average per hour/day. A **Download CSV** button exports the raw readings for spreadsheets.

### CSV export

The **⬇ Download CSV** button downloads the raw logged readings as a spreadsheet-ready file
(`lasco-energy-YYYY-MM-DD.csv`) with columns: timestamp, device_id, device_name, online,
power_w, voltage_v, current_a, energy_kwh. In Daily mode it respects the selected range;
otherwise it exports the last 30 days. You can also hit the endpoint directly:
```
http://<pi-ip>:3000/api/export?deviceId=xxx&days=30
http://<pi-ip>:3000/api/export?days=7          (all devices)
```

### How history is built

Every `logIntervalMinutes` (default 5), the logger records each device's cumulative
`energy_kwh` counter to the local SQLite DB (`energy.db`). The charts compute *consumption*
by taking the difference between cumulative readings:
- **Hourly chart:** last cumulative reading of each hour minus the previous hour
- **Daily chart:** last cumulative reading of each day minus the previous day

This means history starts building from the moment you first run the logger — there's no
back-fill of data from before that. Leave it running and the charts fill in over time.

> Note: each dashboard refresh opens a brief local connection to the device.
> Keep the Smart Life / Lasco app closed while monitoring, since Tuya devices
> allow only one local connection at a time.

---

## 📤 What gets sent to your endpoint

Every hour, your endpoint receives a POST with this JSON body:

```json
{
  "reportedAt": "2026-05-31T14:00:00.000Z",
  "ratePerKwh": 9.0,
  "devices": [
    {
      "id": "a3f14816...",
      "name": "Lasco Wifi Dual Aircon Plug",
      "online": true,
      "switch1": true,
      "switch2": false,
      "power_w": 745.0,
      "voltage_v": 230.6,
      "current_a": 3.23,
      "energy_kwh": 12.34,
      "timestamp": "2026-05-31T14:00:00.000Z"
    }
  ]
}
```

Your receiving server can then store these in a database and calculate
hourly/daily/monthly consumption by comparing `energy_kwh` between reports.

---

## 🛟 Backup safety

If your endpoint is unreachable, each report is still saved locally to
`backup-log.jsonl` (one JSON object per line) so no data is lost. You can
replay these later if needed.

---

## 🔄 Useful commands

```bash
sudo systemctl restart lasco-logger   # restart after config change
sudo systemctl stop lasco-logger      # stop
sudo systemctl disable lasco-logger   # don't start on boot
journalctl -u lasco-logger -f         # alternative log view
```

---

## 💡 Tips

- **Change polling/logging frequency:** `logIntervalMinutes` in `config.json` controls how
  often readings are saved to the DB (default 5). The remote report is always hourly.
- **Static IP for devices:** set a DHCP reservation in your router so device IPs don't change
  (otherwise local connection breaks when IP changes).
- **Counter resets:** the `energy_kwh` value is a cumulative counter on the device. If you
  re-pair a device or it resets, a daily/hourly bar may show as 0 or negative for that period.
  This is cosmetic and self-corrects on the next reading.
- **DB size:** at 5-min logging, the SQLite DB grows by roughly a few MB per year per device —
  negligible. To trim old data: `sqlite3 energy.db "DELETE FROM readings WHERE ts < '2026-01-01';"`
- **Backup your history:** copy `energy.db` periodically if the data matters to you.
