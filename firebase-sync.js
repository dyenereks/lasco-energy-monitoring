/**
 * firebase-sync.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Optional cloud mirror for the Lasco logger, so an online dashboard can read
 * the data from anywhere:
 *
 *   • Firestore         ← every RECORDED reading (the historical log)
 *   • Realtime Database ← the CURRENT/live snapshot (overwritten each poll)
 *
 * Fully opt-in. If config.firebase.enabled is not true, every function here is a
 * no-op and the logger behaves exactly as before. All writes are wrapped and
 * fire-and-forget, so a Firebase outage can never crash the logger or slow down
 * local polling / the local dashboard.
 *
 * Firestore layout:  devices/{deviceId}/readings/{tsKey}
 * Realtime DB layout: <livePath>/{ summary, devices: { <deviceId>: {...} } }
 */

const path = require('path');

let admin = null;   // firebase-admin (required lazily, only when enabled)
let fsdb  = null;   // Firestore handle
let rtdb  = null;   // Realtime Database handle
let cfg   = null;
let ready = false;

// Strip undefined and make the value safe for Realtime Database (which rejects
// undefined and stores arrays as keyed objects anyway).
function clean(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Initialise the Firebase Admin SDK from config.firebase. Safe to call always —
 * it simply returns if Firebase isn't enabled or configured.
 */
function init(firebaseCfg) {
  cfg = firebaseCfg || {};
  if (cfg.enabled !== true) {
    console.log('   Firebase:   disabled');
    return;
  }

  try {
    admin = require('firebase-admin');

    const saPath = path.isAbsolute(cfg.serviceAccountPath)
      ? cfg.serviceAccountPath
      : path.join(__dirname, cfg.serviceAccountPath || './firebase-service-account.json');
    const serviceAccount = require(saPath);

    admin.initializeApp({
      credential:  admin.credential.cert(serviceAccount),
      databaseURL: cfg.databaseURL || undefined,
    });

    fsdb = admin.firestore();
    fsdb.settings({ ignoreUndefinedProperties: true });
    rtdb = cfg.databaseURL ? admin.database() : null;

    ready = true;
    console.log(`   Firebase:   enabled (project ${serviceAccount.project_id})`);
    if (!rtdb) console.log('   Firebase:   no databaseURL set — live sync to Realtime DB is OFF');
  } catch (err) {
    ready = false;
    console.error(`   Firebase:   init FAILED — ${err.message} (continuing without cloud sync)`);
  }
}

/**
 * Mirror recorded readings to Firestore (history). One doc per reading at
 * devices/{deviceId}/readings/{tsKey}. Doc id is derived from the timestamp so
 * re-sending the same reading is idempotent (no duplicates).
 */
function pushReadings(readings) {
  if (!ready || !fsdb || !Array.isArray(readings) || readings.length === 0) return;

  const collName = cfg.readingsCollection || 'readings';
  try {
    const batch = fsdb.batch();
    for (const r of readings) {
      const tsKey = String(r.timestamp).replace(/[:.]/g, '-'); // Firestore-id safe
      const ref = fsdb.collection('devices').doc(r.id)
                      .collection(collName).doc(tsKey);
      batch.set(ref, {
        ts:         r.timestamp,
        time:       admin.firestore.Timestamp.fromDate(new Date(r.timestamp)),
        deviceId:   r.id,
        deviceName: r.name ?? null,
        online:     !!r.online,
        switch1:    r.switch1 ?? null,
        switch2:    r.switch2 ?? null,
        power_w:    r.power_w ?? null,
        voltage_v:  r.voltage_v ?? null,
        current_a:  r.current_a ?? null,
        energy_kwh: r.energy_kwh ?? null,
      });
      // Keep a lightweight device doc up to date (handy for the dashboard list)
      batch.set(fsdb.collection('devices').doc(r.id), {
        deviceId: r.id, deviceName: r.name ?? null, lastSeen: r.timestamp,
      }, { merge: true });
    }
    batch.commit().catch(err =>
      console.error(`   Firestore push failed: ${err.message}`));
  } catch (err) {
    console.error(`   Firestore push error: ${err.message}`);
  }
}

/**
 * Overwrite the live snapshot in Realtime Database. `payload` is the same shape
 * the local dashboard consumes: { devices: [...], summary: {...} }.
 */
function updateLive(payload) {
  if (!ready || !rtdb || !payload) return;

  const livePath = cfg.livePath || 'live';
  try {
    const devicesById = {};
    for (const d of (payload.devices || [])) devicesById[d.id] = d;

    rtdb.ref(livePath).set(clean({
      summary:   payload.summary || {},
      devices:   devicesById,
      updatedAt: Date.now(),
    })).catch(err =>
      console.error(`   RTDB live update failed: ${err.message}`));
  } catch (err) {
    console.error(`   RTDB live update error: ${err.message}`);
  }
}

module.exports = { init, pushReadings, updateLive };
