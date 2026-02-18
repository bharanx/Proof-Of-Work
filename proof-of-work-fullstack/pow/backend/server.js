/**
 * ProofOfWork — Backend API Server
 * Node.js + Express + SQLite + ethers.js
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('better-sqlite3');
const { ethers } = require('ethers');
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'pow-dev-secret-change-in-prod';

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// ── DATABASE ──────────────────────────────────────────────────────────────────
const db = new sqlite3(path.join(__dirname, 'pow.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT,
    sector TEXT,
    wallet_address TEXT UNIQUE,
    public_key TEXT,
    reputation_score REAL DEFAULT 50.0,
    verification_depth INTEGER DEFAULT 0,
    total_days_worked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS work_claims (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    date TEXT NOT NULL,
    hours REAL NOT NULL,
    task TEXT NOT NULL,
    location_lat REAL,
    location_lng REAL,
    status TEXT DEFAULT 'pending',
    ipfs_hash TEXT,
    tx_hash TEXT,
    block_number INTEGER,
    anomaly_score REAL DEFAULT 0.0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (worker_id) REFERENCES workers(id)
  );

  CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL,
    verifier_id TEXT NOT NULL,
    signature TEXT,
    gps_distance_m REAL,
    verified_at TEXT DEFAULT (datetime('now')),
    is_valid INTEGER DEFAULT 1,
    FOREIGN KEY (claim_id) REFERENCES work_claims(id),
    FOREIGN KEY (verifier_id) REFERENCES workers(id)
  );

  CREATE TABLE IF NOT EXISTS supply_chain_certs (
    id TEXT PRIMARY KEY,
    brand TEXT NOT NULL,
    product TEXT NOT NULL,
    batch_weight_kg REAL,
    worker_count INTEGER,
    worker_ids TEXT,
    cert_hash TEXT UNIQUE,
    qr_data TEXT,
    ipfs_hash TEXT,
    issued_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'certified'
  );

  CREATE TABLE IF NOT EXISTS anomaly_flags (
    id TEXT PRIMARY KEY,
    flagged_entity TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    anomaly_type TEXT NOT NULL,
    risk_score REAL NOT NULL,
    description TEXT,
    resolved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS credit_reports (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    tier TEXT NOT NULL,
    max_loan_usd REAL,
    months_on_chain INTEGER,
    avg_peers REAL,
    avg_weekly_hours REAL,
    generated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (worker_id) REFERENCES workers(id)
  );
`);

// ── HELPERS ───────────────────────────────────────────────────────────────────
const genId = () => crypto.randomBytes(16).toString('hex');
const genTxHash = () => '0x' + crypto.randomBytes(32).toString('hex');
const genIpfsHash = () => 'Qm' + crypto.randomBytes(22).toString('base64').replace(/[+/=]/g,'').slice(0,44);

function signJWT(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function verifyJWT(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// Anomaly scoring (simplified ML-like heuristic)
function calcAnomalyScore(workerId, hours, date) {
  let score = 0;
  if (hours > 14) score += 0.4;
  if (hours > 16) score += 0.35;

  // Check recent claims by this worker
  const recent = db.prepare(`
    SELECT hours, date FROM work_claims
    WHERE worker_id = ? AND date >= date(?, '-7 days')
    ORDER BY date DESC LIMIT 10
  `).all(workerId, date);

  const avgHours = recent.length ? recent.reduce((a,b) => a + b.hours, 0) / recent.length : hours;
  if (hours > avgHours * 1.8 && recent.length >= 3) score += 0.25;

  // Check if this exact hour value was submitted many times
  const sameHours = db.prepare(`
    SELECT COUNT(*) as cnt FROM work_claims
    WHERE worker_id = ? AND hours = ? AND date >= date(?, '-14 days')
  `).get(workerId, hours, date);
  if (sameHours.cnt >= 5) score += 0.2;

  return Math.min(score, 1.0);
}

function calcCreditScore(months, peers, hrs) {
  return Math.min(850, Math.round(
    (months * 4.5) + (Math.min(peers, 10) * 15) + (Math.min(hrs, 40) * 2.5) + 300
  ));
}

// ── ROUTES: AUTH / WORKERS ────────────────────────────────────────────────────

// Register worker
app.post('/api/workers/register', (req, res) => {
  const { name, location, sector } = req.body;
  if (!name || !location || !sector) return res.status(400).json({ error: 'Missing fields' });

  // Generate ephemeral wallet (in prod: worker provides their own)
  const wallet = ethers.Wallet.createRandom();
  const id = genId();

  try {
    db.prepare(`
      INSERT INTO workers (id, name, location, sector, wallet_address, public_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, location, sector, wallet.address, wallet.publicKey);

    const token = signJWT({ workerId: id, address: wallet.address });
    res.json({
      success: true,
      worker: { id, name, location, sector, wallet_address: wallet.address },
      privateKey: wallet.privateKey, // In prod: shown once, stored by worker
      token,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get worker profile
app.get('/api/workers/:id', (req, res) => {
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.params.id);
  if (!worker) return res.status(404).json({ error: 'Not found' });

  const claims = db.prepare('SELECT * FROM work_claims WHERE worker_id = ? ORDER BY date DESC LIMIT 20').all(worker.id);
  const verifs = db.prepare(`
    SELECT v.*, wc.task, wc.date, w.name as verifier_name
    FROM verifications v
    JOIN work_claims wc ON v.claim_id = wc.id
    JOIN workers w ON v.verifier_id = w.id
    WHERE wc.worker_id = ? LIMIT 20
  `).all(worker.id);

  res.json({ worker, claims, verifications: verifs });
});

// List all workers (paginated)
app.get('/api/workers', (req, res) => {
  const page = +req.query.page || 1;
  const limit = +req.query.limit || 20;
  const offset = (page - 1) * limit;
  const workers = db.prepare('SELECT id, name, location, sector, reputation_score, total_days_worked, created_at FROM workers LIMIT ? OFFSET ?').all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) as cnt FROM workers').get().cnt;
  res.json({ workers, total, page, pages: Math.ceil(total / limit) });
});

// ── ROUTES: WORK CLAIMS ───────────────────────────────────────────────────────

// Submit work claim
app.post('/api/claims', verifyJWT, (req, res) => {
  const { hours, task, location_lat, location_lng, date } = req.body;
  if (!hours || !task) return res.status(400).json({ error: 'Missing fields' });
  if (hours > 16) return res.status(400).json({ error: 'Hours > 16 automatically rejected' });

  const claimDate = date || new Date().toISOString().slice(0, 10);
  const workerId = req.user.workerId;

  // Check duplicate for same day
  const existing = db.prepare('SELECT id FROM work_claims WHERE worker_id = ? AND date = ?').get(workerId, claimDate);
  if (existing) return res.status(409).json({ error: 'Claim already submitted for this date' });

  const anomalyScore = calcAnomalyScore(workerId, hours, claimDate);
  const id = genId();

  db.prepare(`
    INSERT INTO work_claims (id, worker_id, date, hours, task, location_lat, location_lng, anomaly_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, workerId, claimDate, hours, task, location_lat || null, location_lng || null, anomalyScore);

  // Auto-flag if high anomaly score
  if (anomalyScore > 0.65) {
    db.prepare(`
      INSERT INTO anomaly_flags (id, flagged_entity, entity_type, anomaly_type, risk_score, description)
      VALUES (?, ?, 'claim', 'suspicious_hours', ?, ?)
    `).run(genId(), id, anomalyScore, `Worker claimed ${hours}h — anomaly score ${anomalyScore.toFixed(2)}`);
  }

  res.json({ success: true, claim: { id, date: claimDate, hours, task, status: 'pending', anomaly_score: anomalyScore } });
});

// Get claim details
app.get('/api/claims/:id', (req, res) => {
  const claim = db.prepare('SELECT * FROM work_claims WHERE id = ?').get(req.params.id);
  if (!claim) return res.status(404).json({ error: 'Not found' });
  const verifs = db.prepare('SELECT v.*, w.name as verifier_name FROM verifications v JOIN workers w ON v.verifier_id = w.id WHERE v.claim_id = ?').all(claim.id);
  res.json({ claim, verifications: verifs });
});

// ── ROUTES: PEER VERIFICATION ─────────────────────────────────────────────────

// Submit peer verification
app.post('/api/verify', verifyJWT, (req, res) => {
  const { claim_id, gps_distance_m } = req.body;
  const verifierId = req.user.workerId;

  const claim = db.prepare('SELECT * FROM work_claims WHERE id = ?').get(claim_id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  if (claim.worker_id === verifierId) return res.status(400).json({ error: 'Cannot verify own claim' });
  if (claim.status === 'verified') return res.status(400).json({ error: 'Claim already fully verified' });

  // Check if already verified by this peer
  const dup = db.prepare('SELECT id FROM verifications WHERE claim_id = ? AND verifier_id = ?').get(claim_id, verifierId);
  if (dup) return res.status(409).json({ error: 'Already verified this claim' });

  // GPS check — reject if peer was > 500m away
  if (gps_distance_m && gps_distance_m > 500) {
    return res.status(400).json({ error: 'GPS distance too large — peer must be physically present' });
  }

  // Create cryptographic signature of the claim
  const claimHash = crypto.createHash('sha256').update(JSON.stringify({ claim_id, verifierId, timestamp: Date.now() })).digest('hex');
  const id = genId();

  db.prepare(`
    INSERT INTO verifications (id, claim_id, verifier_id, signature, gps_distance_m)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, claim_id, verifierId, claimHash, gps_distance_m || null);

  // Update verifier's depth score
  db.prepare('UPDATE workers SET verification_depth = verification_depth + 1 WHERE id = ?').run(verifierId);

  // Check if 3 verifications collected → seal claim
  const verifCount = db.prepare('SELECT COUNT(*) as cnt FROM verifications WHERE claim_id = ? AND is_valid = 1').get(claim_id).cnt;

  if (verifCount >= 3) {
    const txHash = genTxHash();
    const ipfsHash = genIpfsHash();
    db.prepare('UPDATE work_claims SET status = ?, tx_hash = ?, ipfs_hash = ?, block_number = ? WHERE id = ?')
      .run('verified', txHash, ipfsHash, Math.floor(48000 + Math.random() * 1000), claim_id);
    db.prepare('UPDATE workers SET total_days_worked = total_days_worked + 1, reputation_score = MIN(100, reputation_score + 0.5) WHERE id = ?')
      .run(claim.worker_id);

    return res.json({ success: true, verification_id: id, claim_sealed: true, tx_hash: txHash, ipfs_hash: ipfsHash });
  }

  res.json({ success: true, verification_id: id, claim_sealed: false, verifications_so_far: verifCount });
});

// ── ROUTES: SUPPLY CHAIN ──────────────────────────────────────────────────────

// Issue batch certificate
app.post('/api/supplychain/certify', async (req, res) => {
  const { brand, product, batch_weight_kg, worker_ids } = req.body;
  if (!brand || !product || !worker_ids?.length) return res.status(400).json({ error: 'Missing fields' });

  // Validate all workers have sufficient verified claims
  const eligible = worker_ids.filter(wid => {
    const w = db.prepare('SELECT total_days_worked FROM workers WHERE id = ?').get(wid);
    return w && w.total_days_worked >= 1;
  });

  if (eligible.length < worker_ids.length * 0.7) {
    return res.status(400).json({ error: 'Insufficient verified labor for certification' });
  }

  const id = genId();
  const certHash = crypto.createHash('sha256').update(JSON.stringify({ brand, product, worker_ids, ts: Date.now() })).digest('hex');
  const ipfsHash = genIpfsHash();

  const qrPayload = JSON.stringify({ cert_id: id, brand, product, workers: eligible.length, cert_hash: certHash, ipfs: ipfsHash });

  db.prepare(`
    INSERT INTO supply_chain_certs (id, brand, product, batch_weight_kg, worker_count, worker_ids, cert_hash, qr_data, ipfs_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, brand, product, batch_weight_kg || null, eligible.length, JSON.stringify(eligible), certHash, qrPayload, ipfsHash);

  // Generate QR code as data URL
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });

  res.json({ success: true, cert_id: id, cert_hash: certHash, ipfs_hash: ipfsHash, worker_count: eligible.length, qr_code: qrDataUrl, qr_payload: qrPayload });
});

// List certifications
app.get('/api/supplychain/certs', (req, res) => {
  const certs = db.prepare('SELECT id, brand, product, batch_weight_kg, worker_count, cert_hash, issued_at, status FROM supply_chain_certs ORDER BY issued_at DESC LIMIT 50').all();
  res.json({ certs });
});

// Verify a cert by hash (public endpoint — used by scanners)
app.get('/api/supplychain/verify/:certHash', (req, res) => {
  const cert = db.prepare('SELECT * FROM supply_chain_certs WHERE cert_hash = ?').get(req.params.certHash);
  if (!cert) return res.status(404).json({ error: 'Certificate not found', valid: false });
  res.json({ valid: true, cert });
});

// ── ROUTES: FINANCE / CREDIT ──────────────────────────────────────────────────

// Generate credit report
app.post('/api/finance/credit', verifyJWT, (req, res) => {
  const workerId = req.user.workerId;
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });

  // Compute from real on-chain data
  const verifiedClaims = db.prepare('SELECT * FROM work_claims WHERE worker_id = ? AND status = ?').all(workerId, 'verified');
  if (!verifiedClaims.length) return res.status(400).json({ error: 'No verified claims on chain yet' });

  const months = Math.max(1, Math.round(worker.total_days_worked / 22));
  const avgHrs = verifiedClaims.reduce((a, b) => a + b.hours, 0) / verifiedClaims.length;
  const weeklyHrs = avgHrs * 5;

  // Average peers per claim
  const peerCounts = verifiedClaims.map(c => {
    return db.prepare('SELECT COUNT(*) as cnt FROM verifications WHERE claim_id = ?').get(c.id).cnt;
  });
  const avgPeers = peerCounts.reduce((a, b) => a + b, 0) / peerCounts.length;

  const score = calcCreditScore(months, avgPeers, weeklyHrs);
  const tier = score > 720 ? 'PRIME' : score > 580 ? 'STANDARD' : 'EMERGING';
  const maxLoan = Math.round(score * months * 2.8);

  const reportId = genId();
  db.prepare(`
    INSERT INTO credit_reports (id, worker_id, score, tier, max_loan_usd, months_on_chain, avg_peers, avg_weekly_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(reportId, workerId, score, tier, maxLoan, months, avgPeers, weeklyHrs);

  res.json({
    report_id: reportId,
    worker_name: worker.name,
    score,
    tier,
    max_loan_usd: maxLoan,
    months_on_chain: months,
    avg_peers: avgPeers.toFixed(1),
    avg_weekly_hours: weeklyHrs.toFixed(1),
    verified_claims: verifiedClaims.length,
    generated_at: new Date().toISOString(),
  });
});

// ── ROUTES: AI ANOMALY ────────────────────────────────────────────────────────

// Run anomaly scan
app.post('/api/ai/scan', (req, res) => {
  const { region, anomaly_type } = req.body;

  const flags = [];

  // 1. Detect impossible hours (>16/day)
  const impossibleHours = db.prepare(`
    SELECT wc.id, w.name, w.location, wc.hours, wc.date
    FROM work_claims wc JOIN workers w ON wc.worker_id = w.id
    WHERE wc.hours > 16 ${region ? "AND w.location LIKE '%" + region + "%'" : ''}
  `).all();
  impossibleHours.forEach(c => {
    flags.push({ type: 'impossible_hours', risk: 'high', score: 0.92, entity: c.id, label: `${c.name} claimed ${c.hours}h on ${c.date}`, detail: 'Hours exceed physiological maximum' });
  });

  // 2. Clique detection — workers who only verify each other
  const workers = db.prepare('SELECT DISTINCT verifier_id FROM verifications').all();
  workers.forEach(w => {
    const verifiedBy = db.prepare(`SELECT DISTINCT v.claim_id, wc.worker_id FROM verifications v JOIN work_claims wc ON v.claim_id = wc.id WHERE v.verifier_id = ?`).all(w.verifier_id);
    const uniqueWorkers = new Set(verifiedBy.map(x => x.worker_id));
    if (uniqueWorkers.size === 1 && verifiedBy.length >= 5) {
      flags.push({ type: 'clique', risk: 'high', score: 0.87, entity: w.verifier_id, label: `Clique: Verifier only signs 1 worker`, detail: `${verifiedBy.length} verifications — all for the same worker` });
    }
  });

  // 3. Timestamp clustering
  const clusters = db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:%M', created_at) as minute, COUNT(*) as cnt
    FROM work_claims GROUP BY minute HAVING cnt >= 4
  `).all();
  clusters.forEach(c => {
    flags.push({ type: 'timestamp_cluster', risk: 'medium', score: 0.71, entity: c.minute, label: `${c.cnt} claims in 1 minute window`, detail: `Suspicious simultaneous submissions at ${c.minute}` });
  });

  // 4. Pull existing flags from DB
  const dbFlags = db.prepare('SELECT * FROM anomaly_flags WHERE resolved = 0 ORDER BY risk_score DESC LIMIT 10').all();
  dbFlags.forEach(f => {
    flags.push({ type: f.anomaly_type, risk: f.risk_score > 0.7 ? 'high' : 'medium', score: f.risk_score, entity: f.flagged_entity, label: f.description, detail: `Flagged at ${f.created_at}` });
  });

  const high = flags.filter(f => f.risk === 'high').length;
  const medium = flags.filter(f => f.risk === 'medium').length;

  res.json({ flags, summary: { total: flags.length, high, medium, low: flags.length - high - medium }, scanned_at: new Date().toISOString() });
});

// ── ROUTES: STATS ─────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const totalWorkers = db.prepare('SELECT COUNT(*) as cnt FROM workers').get().cnt;
  const totalClaims = db.prepare('SELECT COUNT(*) as cnt FROM work_claims').get().cnt;
  const verifiedClaims = db.prepare('SELECT COUNT(*) as cnt FROM work_claims WHERE status = ?').get('verified').cnt;
  const totalVerifs = db.prepare('SELECT COUNT(*) as cnt FROM verifications').get().cnt;
  const totalCerts = db.prepare('SELECT COUNT(*) as cnt FROM supply_chain_certs').get().cnt;
  const flags = db.prepare('SELECT COUNT(*) as cnt FROM anomaly_flags WHERE resolved = 0').get().cnt;

  res.json({ totalWorkers, totalClaims, verifiedClaims, totalVerifs, totalCerts, openFlags: flags, blockNumber: 48291 + totalVerifs });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`ProofOfWork API running on port ${PORT}`));

module.exports = app;
