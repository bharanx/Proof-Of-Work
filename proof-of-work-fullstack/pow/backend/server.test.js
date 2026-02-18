/**
 * ProofOfWork API Tests
 * Run: npm test
 */

const request = require('supertest');
const app = require('../backend/server');

let workerToken = '';
let workerId = '';
let claimId = '';

describe('ProofOfWork API', () => {

  describe('Health', () => {
    it('GET /health returns ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('Stats', () => {
    it('GET /api/stats returns counts', async () => {
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalWorkers');
    });
  });

  describe('Worker Registration', () => {
    it('registers a new worker', async () => {
      const res = await request(app)
        .post('/api/workers/register')
        .send({ name: 'Test Worker', location: 'Kericho, KE', sector: 'Agriculture — Tea' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeTruthy();
      expect(res.body.worker.wallet_address).toMatch(/^0x/);

      workerToken = res.body.token;
      workerId = res.body.worker.id;
    });

    it('rejects missing fields', async () => {
      const res = await request(app)
        .post('/api/workers/register')
        .send({ name: 'No Sector' });
      expect(res.status).toBe(400);
    });

    it('fetches worker profile', async () => {
      const res = await request(app).get(`/api/workers/${workerId}`);
      expect(res.status).toBe(200);
      expect(res.body.worker.name).toBe('Test Worker');
    });
  });

  describe('Work Claims', () => {
    it('requires auth to submit claim', async () => {
      const res = await request(app).post('/api/claims').send({ hours: 8, task: 'Tea picking' });
      expect(res.status).toBe(401);
    });

    it('submits a valid claim', async () => {
      const res = await request(app)
        .post('/api/claims')
        .set('Authorization', `Bearer ${workerToken}`)
        .send({ hours: 8, task: 'Tea harvesting Row 12', date: '2026-01-15' });

      expect(res.status).toBe(200);
      expect(res.body.claim.status).toBe('pending');
      claimId = res.body.claim.id;
    });

    it('rejects impossible hours', async () => {
      const res = await request(app)
        .post('/api/claims')
        .set('Authorization', `Bearer ${workerToken}`)
        .send({ hours: 20, task: 'Impossible task', date: '2026-01-16' });
      expect(res.status).toBe(400);
    });

    it('rejects duplicate claim for same day', async () => {
      const res = await request(app)
        .post('/api/claims')
        .set('Authorization', `Bearer ${workerToken}`)
        .send({ hours: 6, task: 'Another claim', date: '2026-01-15' });
      expect(res.status).toBe(409);
    });

    it('fetches claim details', async () => {
      const res = await request(app).get(`/api/claims/${claimId}`);
      expect(res.status).toBe(200);
      expect(res.body.claim.id).toBe(claimId);
    });
  });

  describe('Supply Chain', () => {
    it('lists certificates', async () => {
      const res = await request(app).get('/api/supplychain/certs');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.certs)).toBe(true);
    });

    it('returns 404 for invalid cert hash', async () => {
      const res = await request(app).get('/api/supplychain/verify/invalidhash000');
      expect(res.status).toBe(404);
      expect(res.body.valid).toBe(false);
    });
  });

  describe('AI Anomaly', () => {
    it('runs anomaly scan', async () => {
      const res = await request(app).post('/api/ai/scan').send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('flags');
      expect(res.body).toHaveProperty('summary');
    });

    it('scans with region filter', async () => {
      const res = await request(app).post('/api/ai/scan').send({ region: 'Kericho' });
      expect(res.status).toBe(200);
    });
  });

});
