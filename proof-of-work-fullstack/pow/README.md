# ProofOfWork — Global Labor Verification Protocol

> A decentralized oracle for human work. Every worker becomes a node in a global trust network.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   FRONTEND (HTML/JS)                 │
│   Passport · Verify · Supply Chain · Finance · AI    │
└──────────────────────┬──────────────────────────────┘
                       │ REST API
┌──────────────────────▼──────────────────────────────┐
│              BACKEND (Node.js + Express)             │
│   Auth · Claims · Verification · Certs · AI Scan    │
│              SQLite (dev) / PostgreSQL (prod)        │
└──────────┬─────────────────────────┬────────────────┘
           │ ethers.js               │ QRCode / IPFS
┌──────────▼──────────┐   ┌─────────▼──────────────┐
│   SMART CONTRACT    │   │     IPFS NODE           │
│  ProofOfWork.sol    │   │  Immutable work records │
│  Sepolia testnet    │   │  go-ipfs (Docker)       │
└─────────────────────┘   └────────────────────────┘
```

---

## Quick Start

### 1. Backend API

```bash
cd backend
npm install
node ../scripts/seed.js   # populate demo data
npm start                 # → http://localhost:3001
```

### 2. Frontend

Open `frontend/index.html` in your browser.  
For production, serve with any static server:
```bash
npx serve frontend/
```

### 3. Full Stack with Docker

```bash
cp .env.example .env
# Edit .env with your values
docker-compose up
```

- Frontend: http://localhost:3000
- API: http://localhost:3001
- IPFS Gateway: http://localhost:8080

---

## API Reference

### Workers
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/workers/register` | No | Register new worker, returns JWT |
| GET | `/api/workers` | No | List all workers (paginated) |
| GET | `/api/workers/:id` | No | Get worker + claims + verifications |

### Work Claims
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/claims` | ✓ | Submit work claim |
| GET | `/api/claims/:id` | No | Get claim details + verifications |

### Peer Verification
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/verify` | ✓ | Sign a peer's work claim |

### Supply Chain
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/supplychain/certify` | No | Issue batch certificate + QR |
| GET | `/api/supplychain/certs` | No | List all certifications |
| GET | `/api/supplychain/verify/:hash` | No | Verify cert by hash (public) |

### Finance
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/finance/credit` | ✓ | Generate labor credit report |

### AI
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/ai/scan` | No | Run anomaly detection scan |

### General
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats` | Protocol-wide statistics |
| GET | `/health` | Health check |

---

## Smart Contract

### Deploy to local Hardhat node
```bash
cd contracts
npm install
npx hardhat node                          # start local blockchain
npx hardhat run scripts/deploy.js --network localhost
```

### Deploy to Sepolia testnet
```bash
# Fill SEPOLIA_RPC_URL and PRIVATE_KEY in .env
npx hardhat run scripts/deploy.js --network sepolia
# Then add CONTRACT_ADDRESS to backend/.env
```

### Key functions
```solidity
registerWorker(name, location, sector)
submitClaim(date, hoursX10, taskIpfsHash) → claimId
verifyClaim(claimId)              // requires 3 unique peers
issueCert(brand, productHash, workerWallets) → certId
getCreditProxy(wallet) → (verifiedDays, reputationScore, tenureMonths)
```

---

## Data Model

```
workers ──┬──< work_claims ──┬──< verifications
          │                  └──< anomaly_flags
          └──< credit_reports

supply_chain_certs (references worker ids)
```

---

## Proof-of-Human-Work Consensus

1. Worker submits claim (hours, task, GPS optional)
2. AI scores it for anomalies (0.0 – 1.0)
3. 3 physically-present peers scan QR and sign
4. GPS distance validated (< 500m)
5. 3 valid signatures → claim sealed on-chain (IPFS + blockchain)
6. Worker reputation +0.5, verifier reputation +0.5 each

**Slashing:** Owner can slash verifiers proven to have falsely verified.  
Reputation loss: −5.0 points per false verification.

---

## AI Anomaly Detection

Heuristics applied per scan:
- **Impossible hours**: > 16h/day flagged
- **Clique detection**: verifiers who only sign one worker
- **Timestamp clustering**: many claims in <60 seconds
- **Historical deviation**: hours > 1.8× personal average

Scores > 0.65 → auto-flagged in `anomaly_flags` table.  
Scores > 0.72 → escalated for human spot-check.

---

## Roadmap

- [ ] Full ethers.js integration (write claims directly to contract)
- [ ] IPFS pinning (Pinata/Infura) for task descriptions
- [ ] Mobile QR scanner (React Native)
- [ ] Zero-Knowledge proof of labor for privacy-preserving credit
- [ ] DAO governance for protocol parameters
- [ ] Multi-language support (Swahili, Amharic, Bengali)
- [ ] Offline-first mobile app (sync when connected)

---

## License

MIT — This protocol belongs to the workers.
