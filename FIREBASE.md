# Firebase cloud sync (optional)

Mirror the Pi's data to Firebase so an **online dashboard** can read it from anywhere.

| What | Where it goes | When |
|---|---|---|
| **Recorded readings** (history) | **Cloud Firestore** | every time a reading is logged (`logIntervalMinutes`) |
| **Current/live snapshot** | **Realtime Database** | every poll (overwrites the previous snapshot) |

It is **fully opt-in**. With `firebase.enabled: false` (the default) the logger behaves
exactly as before. All cloud writes are fire-and-forget and wrapped in error handling,
so a Firebase outage can never crash the logger or slow down local polling.

---

## 1. Create a Firebase project

1. Go to <https://console.firebase.google.com> → **Add project**.
2. (Analytics is optional — you can skip it.)

## 2. Enable the two databases

- **Firestore:** Build → **Firestore Database** → *Create database* → Production mode → pick a region (e.g. `asia-southeast1` for PH).
- **Realtime Database:** Build → **Realtime Database** → *Create database* → Locked mode.
  Copy its URL — it looks like `https://YOUR_PROJECT-default-rtdb.firebaseio.com` or
  `https://YOUR_PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app`.

## 3. Generate a service account key

1. ⚙️ **Project settings** → **Service accounts** → **Generate new private key**.
2. A `.json` file downloads. Copy it onto the Pi as:
   ```
   ~/lasco-pi-logger/firebase-service-account.json
   ```
   (Use `scp`, a USB drive, or paste it with `nano`.)

> 🔒 This key grants full admin access to your project. It's already in `.gitignore`
> (`firebase-service-account.json`) — **never commit it**.

## 4. Configure `config.json` on the Pi

Add a `firebase` block (see `config.example.json`):

```json
"firebase": {
  "enabled": true,
  "serviceAccountPath": "./firebase-service-account.json",
  "databaseURL": "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  "readingsCollection": "readings",
  "livePath": "live"
}
```

## 5. Install the dependency and restart

```bash
cd ~/lasco-pi-logger
git pull
npm install                       # pulls in firebase-admin
sudo systemctl restart lasco-logger
```

On startup you should see:
```
   Firebase:   enabled (project your-project-id)
```
If something's wrong it logs `Firebase: init FAILED — <reason>` and keeps running locally.

---

## Data layout (for building your online dashboard)

### Firestore — history
```
devices/{deviceId}                       ← { deviceId, deviceName, lastSeen }
devices/{deviceId}/readings/{tsKey}      ← one document per reading:
    {
      ts:         "2026-06-29T08:00:00.000Z",
      time:       <Firestore Timestamp>,   // use this for range queries / orderBy
      deviceId, deviceName, online,
      switch1, switch2,
      power_w, voltage_v, current_a, energy_kwh
    }
```
Example query (web SDK): readings for a device on a day, ordered by time —
`collection(db, 'devices', id, 'readings')` with `where('time','>=',start)`,
`where('time','<',end)`, `orderBy('time')`.

### Realtime Database — live
```
live/
  updatedAt: <ms epoch>
  summary:   { totalPower, totalEnergy, totalCost, onlineCount, totalCount,
               ratePerKwh, reportStatus, updatedAt }
  devices/
    {deviceId}: { id, name, online, switch1, switch2,
                  power_w, voltage_v, current_a, energy_kwh, timestamp }
```
Subscribe with `onValue(ref(rtdb, 'live'))` for a real-time live view.

---

## Security rules

The Pi uses the **service account**, which bypasses security rules entirely, so you can
keep both databases **locked** and only open *read* access the way your online dashboard
needs it. Two common choices:

- **Authenticated reads** (recommended): require Firebase Auth sign-in, then allow read.
- **Public read, no write** (simplest, but exposes your usage data publicly):

  Realtime Database rules:
  ```json
  { "rules": { "live": { ".read": true, ".write": false } } }
  ```
  Firestore rules:
  ```
  match /devices/{d}/{document=**} { allow read: if true; allow write: if false; }
  ```

Writes are always denied to clients — only the Pi (service account) writes.

---

## Cost

At `logIntervalMinutes: 1` with one device that's ~1,440 Firestore writes/day — well within
the free **Spark** plan (20k writes/day). The Realtime Database `live` node is tiny and just
gets overwritten. Two devices ≈ 2,880 writes/day, still free. If you add many devices or want
cheap daily charts online, ask and we can also push a per-day rollup doc instead of reading
all raw readings client-side.
