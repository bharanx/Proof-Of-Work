/**
 * Seed script — populates the DB with realistic demo data
 * Run: node scripts/seed.js
 */

const sqlite3 = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const { ethers } = require('ethers');

const db = new sqlite3(path.join(__dirname, '../backend/pow.db'));
const genId = () => crypto.randomBytes(16).toString('hex');
const genTxHash = () => '0x' + crypto.randomBytes(32).toString('hex');
const genIpfsHash = () => 'Qm' + crypto.randomBytes(22).toString('base64').replace(/[+/=]/g,'').slice(0,44);

const WORKERS = [
  { name: 'Amina Korir', location: 'Kericho, KE', sector: 'Agriculture — Tea' },
  { name: 'Joseph Omondi', location: 'Kericho, KE', sector: 'Agriculture — Tea' },
  { name: 'Fatuma Wanjiku', location: 'Kericho, KE', sector: 'Agriculture — Tea' },
  { name: 'Kibeti Mwangi', location: 'Nairobi, KE', sector: 'Construction' },
  { name: 'Abebe Girma', location: 'Oromia, ET', sector: 'Agriculture — Coffee' },
  { name: 'Tigist Haile', location: 'Oromia, ET', sector: 'Agriculture — Coffee' },
  { name: 'Kofi Mensah', location: 'Ashanti, GH', sector: 'Agriculture — Cocoa' },
  { name: 'Ama Owusu', location: 'Ashanti, GH', sector: 'Agriculture — Cocoa' },
  { name: 'Nasrin Begum', location: 'Dhaka, BD', sector: 'Textile Manufacturing' },
  { name: 'Ratan Das', location: 'Dhaka, BD', sector: 'Textile Manufacturing' },
];

const TASKS = [
  'Tea leaf harvesting — Row 14-18',
  'Tea sorting and weighing',
  'Coffee cherry picking — Block C',
  'Cocoa pod harvesting',
  'Garment stitching — Order #447',
  'Construction — Foundation pour',
  'Quality inspection — Batch 22',
  'Loading and logistics',
  'Pruning and maintenance',
  'Post-harvest processing',
];

console.log('🌱 Seeding ProofOfWork database...\n');

// Clear existing data
db.exec(`
  DELETE FROM verifications;
  DELETE FROM work_claims;
  DELETE FROM supply_chain_certs;
  DELETE FROM anomaly_flags;
  DELETE FROM credit_reports;
  DELETE FROM workers;
`);

// Insert workers
const workerIds = [];
WORKERS.forEach(w => {
  const wallet = ethers.Wallet.createRandom();
  const id = genId();
  workerIds.push(id);
  const rep = 50 + Math.random() * 35;
  const days = Math.floor(10 + Math.random() * 60);

  db.prepare(`
    INSERT INTO workers (id, name, location, sector, wallet_address, public_key, reputation_score, verification_depth, total_days_worked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, w.name, w.location, w.sector, wallet.address, wallet.publicKey, rep, Math.floor(days * 0.8), days);

  console.log(`  ✓ Worker: ${w.name} (${w.location})`);
});

// Insert work claims + verifications
const claimIds = [];
for (let day = 30; day >= 1; day--) {
  const date = new Date();
  date.setDate(date.getDate() - day);
  const dateStr = date.toISOString().slice(0, 10);

  // 6-8 workers submit claims each day
  const shuffled = [...workerIds].sort(() => Math.random() - 0.5).slice(0, 6 + Math.floor(Math.random() * 3));

  shuffled.forEach(workerId => {
    const hours = 5 + Math.random() * 6;
    const task = TASKS[Math.floor(Math.random() * TASKS.length)];
    const anomalyScore = hours > 13 ? 0.6 + Math.random() * 0.3 : Math.random() * 0.2;
    const id = genId();
    claimIds.push({ id, workerId });

    db.prepare(`
      INSERT INTO work_claims (id, worker_id, date, hours, task, anomaly_score, status, tx_hash, ipfs_hash, block_number)
      VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?)
    `).run(id, workerId, dateStr, +hours.toFixed(1), task, anomalyScore, genTxHash(), genIpfsHash(), 48000 + Math.floor(Math.random() * 300));

    // Add 3 verifiers from other workers
    const verifiers = workerIds.filter(w => w !== workerId).sort(() => Math.random() - 0.5).slice(0, 3);
    verifiers.forEach(verifierId => {
      db.prepare(`
        INSERT INTO verifications (id, claim_id, verifier_id, signature, gps_distance_m)
        VALUES (?, ?, ?, ?, ?)
      `).run(genId(), id, verifierId, crypto.randomBytes(32).toString('hex'), Math.floor(Math.random() * 50));
    });
  });
}
console.log(`\n  ✓ Inserted ${claimIds.length} work claims with verifications`);

// Supply chain certs
const certData = [
  { brand: 'FairHarvest Co', product: 'Kenya AA Tea — Kericho Estate', kg: 2400, workers: workerIds.slice(0, 4) },
  { brand: 'TrueRoast', product: 'Ethiopia Yirgacheffe Single Origin', kg: 850, workers: workerIds.slice(4, 7) },
  { brand: 'PureThread', product: 'Organic Cotton T-Shirts Batch #22', kg: 1200, workers: workerIds.slice(8) },
];

certData.forEach(c => {
  const id = genId();
  const certHash = crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');
  db.prepare(`
    INSERT INTO supply_chain_certs (id, brand, product, batch_weight_kg, worker_count, worker_ids, cert_hash, ipfs_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, c.brand, c.product, c.kg, c.workers.length, JSON.stringify(c.workers), certHash, genIpfsHash());
  console.log(`  ✓ Cert: ${c.brand} — ${c.product}`);
});

// Anomaly flags
const anomalies = [
  { entity: claimIds[0]?.id || genId(), type: 'impossible_hours', risk: 0.91, desc: 'Worker claimed 17.5h in a single day — exceeds maximum threshold' },
  { entity: workerIds[0] + '_group', type: 'clique_collusion', risk: 0.84, desc: 'Group of 5 workers exclusively verify each other — 32 mutual verifications in 7 days' },
  { entity: claimIds[2]?.id || genId(), type: 'gps_mismatch', risk: 0.73, desc: 'Claim submitted from Kericho but GPS coordinates indicate Nairobi (~280km away)' },
];
anomalies.forEach(a => {
  db.prepare(`
    INSERT INTO anomaly_flags (id, flagged_entity, entity_type, anomaly_type, risk_score, description)
    VALUES (?, ?, 'claim', ?, ?, ?)
  `).run(genId(), a.entity, a.type, a.risk, a.desc);
});
console.log(`  ✓ Inserted ${anomalies.length} anomaly flags\n`);

const stats = {
  workers: db.prepare('SELECT COUNT(*) as c FROM workers').get().c,
  claims: db.prepare('SELECT COUNT(*) as c FROM work_claims').get().c,
  verifications: db.prepare('SELECT COUNT(*) as c FROM verifications').get().c,
  certs: db.prepare('SELECT COUNT(*) as c FROM supply_chain_certs').get().c,
};

console.log('✅ Seed complete!\n');
console.log('  Workers:       ', stats.workers);
console.log('  Work Claims:   ', stats.claims);
console.log('  Verifications: ', stats.verifications);
console.log('  Certs:         ', stats.certs);
console.log('\nRun: node backend/server.js');
