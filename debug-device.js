/**
 * Quick diagnostic — dumps the RAW DPS values from your first configured device.
 *
 *   node debug-device.js
 *
 * Use the output to confirm the DPS code mapping in index.js. In particular,
 * find which numeric code holds the cumulative ENERGY counter (it should be a
 * number that slowly grows over time). On many Tuya plugs it's 17 (add_ele),
 * on others 26 — this tells you which one your device actually uses.
 */
const TuyAPI = require('tuyapi');
const fs     = require('fs');
const path   = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const cfg    = config.devices[0];

const device = new TuyAPI({
  id:      cfg.id,
  key:     cfg.key,
  ip:      cfg.ip,
  version: cfg.version || '3.4',
  issueGetOnConnect: true,
});

device.on('error', (e) => console.error('Device error:', e.message));

(async () => {
  try {
    await device.find();
    await device.connect();
    const data = await device.get({ schema: true });
    device.disconnect();

    console.log(`\nDevice: ${cfg.name}  (${cfg.ip})`);
    console.log('─'.repeat(50));
    console.log('RAW DPS values returned by the device:\n');
    console.log(JSON.stringify(data.dps, null, 2));
    console.log('\n─'.repeat(50));
    console.log('Typical Lasco/Tuya energy-plug mapping:');
    console.log('   1, 2     = switches (on/off)');
    console.log('   18       = current  (mA      → /1000 = A)');
    console.log('   19       = power    (W x10   → /10   = W)');
    console.log('   20       = voltage  (V x10   → /10   = V)');
    console.log('   17 or 26 = cumulative energy → find the one that GROWS');
    console.log('\nWhatever code holds the growing kWh counter is the one');
    console.log('that "energy" must point to in index.js (DPS.energy).');
    process.exit(0);
  } catch (e) {
    console.error('\nFailed to read device:', e.message);
    console.error('(Make sure the Smart Life / Lasco app is CLOSED.)');
    process.exit(1);
  }
})();
