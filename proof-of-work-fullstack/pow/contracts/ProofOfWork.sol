// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ProofOfWork — On-Chain Labor Verification Protocol
 *
 * Workers submit work claims. Three peer-verifiers must sign
 * each claim using cryptographic signatures before it is sealed
 * immutably on-chain. Reputation is tracked per wallet.
 *
 * Deploy: Ethereum testnet (Sepolia) or any EVM-compatible chain.
 */

contract ProofOfWork {

    // ── STRUCTS ───────────────────────────────────────────────────────────────

    struct Worker {
        address wallet;
        string name;
        string location;
        string sector;
        uint256 reputationScore;   // scaled by 100 (e.g., 7500 = 75.00)
        uint256 verifiedDays;
        uint256 registeredAt;
        bool isActive;
    }

    struct WorkClaim {
        bytes32 id;
        address worker;
        uint256 date;          // Unix timestamp (day-precision)
        uint256 hours;         // hours × 10 (e.g., 80 = 8.0h)
        string taskHash;       // IPFS hash of task description
        address[] verifiers;
        ClaimStatus status;
        bytes32 ipfsRecord;    // IPFS hash of sealed record
        uint256 sealedAt;
    }

    struct SupplyChainCert {
        bytes32 id;
        string brand;
        string productHash;
        address[] verifiedWorkers;
        uint256 issuedAt;
        bool isValid;
    }

    enum ClaimStatus { Pending, PartiallyVerified, Verified, Rejected }

    // ── CONSTANTS ─────────────────────────────────────────────────────────────

    uint256 public constant REQUIRED_VERIFIERS = 3;
    uint256 public constant MAX_DAILY_HOURS = 160;    // 16.0 hours × 10
    uint256 public constant REP_GAIN_VERIFY = 50;     // +0.50 rep on verify
    uint256 public constant REP_LOSS_FALSE = 500;     // -5.00 rep on false verify
    uint256 public constant BASE_REP = 5000;          // 50.00 starting rep

    // ── STATE ─────────────────────────────────────────────────────────────────

    mapping(address => Worker) public workers;
    mapping(bytes32 => WorkClaim) public claims;
    mapping(address => bytes32[]) public workerClaims;
    mapping(bytes32 => SupplyChainCert) public certs;
    mapping(address => bool) public registeredWorkers;
    mapping(bytes32 => mapping(address => bool)) public hasVerified;

    address public owner;
    uint256 public totalWorkers;
    uint256 public totalVerifiedClaims;
    uint256 public totalCerts;

    // ── EVENTS ────────────────────────────────────────────────────────────────

    event WorkerRegistered(address indexed wallet, string name, uint256 timestamp);
    event ClaimSubmitted(bytes32 indexed claimId, address indexed worker, uint256 date, uint256 hours);
    event ClaimVerified(bytes32 indexed claimId, address indexed verifier, uint256 verifierCount);
    event ClaimSealed(bytes32 indexed claimId, bytes32 ipfsHash, uint256 sealedAt);
    event CertIssued(bytes32 indexed certId, string brand, uint256 workerCount);
    event ReputationChanged(address indexed worker, uint256 oldScore, uint256 newScore);

    // ── MODIFIERS ─────────────────────────────────────────────────────────────

    modifier onlyRegistered() {
        require(registeredWorkers[msg.sender], "Worker not registered");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // ── CONSTRUCTOR ───────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ── REGISTRATION ──────────────────────────────────────────────────────────

    function registerWorker(
        string calldata name,
        string calldata location,
        string calldata sector
    ) external {
        require(!registeredWorkers[msg.sender], "Already registered");
        require(bytes(name).length > 0, "Name required");

        workers[msg.sender] = Worker({
            wallet: msg.sender,
            name: name,
            location: location,
            sector: sector,
            reputationScore: BASE_REP,
            verifiedDays: 0,
            registeredAt: block.timestamp,
            isActive: true
        });

        registeredWorkers[msg.sender] = true;
        totalWorkers++;

        emit WorkerRegistered(msg.sender, name, block.timestamp);
    }

    // ── CLAIM SUBMISSION ──────────────────────────────────────────────────────

    function submitClaim(
        uint256 date,
        uint256 hoursX10,
        string calldata taskHash
    ) external onlyRegistered returns (bytes32 claimId) {
        require(hoursX10 > 0 && hoursX10 <= MAX_DAILY_HOURS, "Invalid hours");
        require(bytes(taskHash).length > 0, "Task hash required");

        claimId = keccak256(abi.encodePacked(msg.sender, date, block.timestamp));

        WorkClaim storage claim = claims[claimId];
        claim.id = claimId;
        claim.worker = msg.sender;
        claim.date = date;
        claim.hours = hoursX10;
        claim.taskHash = taskHash;
        claim.status = ClaimStatus.Pending;

        workerClaims[msg.sender].push(claimId);

        emit ClaimSubmitted(claimId, msg.sender, date, hoursX10);
    }

    // ── PEER VERIFICATION ─────────────────────────────────────────────────────

    function verifyClaim(bytes32 claimId) external onlyRegistered {
        WorkClaim storage claim = claims[claimId];
        require(claim.worker != address(0), "Claim not found");
        require(claim.worker != msg.sender, "Cannot verify own claim");
        require(!hasVerified[claimId][msg.sender], "Already verified");
        require(claim.status != ClaimStatus.Verified, "Already sealed");
        require(claim.status != ClaimStatus.Rejected, "Claim rejected");

        // Verifier must have minimum reputation
        require(workers[msg.sender].reputationScore >= 1000, "Reputation too low to verify");

        hasVerified[claimId][msg.sender] = true;
        claim.verifiers.push(msg.sender);

        // Update verifier reputation
        uint256 oldRep = workers[msg.sender].reputationScore;
        workers[msg.sender].reputationScore += REP_GAIN_VERIFY;
        emit ReputationChanged(msg.sender, oldRep, workers[msg.sender].reputationScore);

        uint256 count = claim.verifiers.length;
        emit ClaimVerified(claimId, msg.sender, count);

        if (count >= REQUIRED_VERIFIERS) {
            _sealClaim(claimId);
        } else {
            claim.status = ClaimStatus.PartiallyVerified;
        }
    }

    function _sealClaim(bytes32 claimId) internal {
        WorkClaim storage claim = claims[claimId];
        claim.status = ClaimStatus.Verified;
        claim.sealedAt = block.timestamp;

        // Generate deterministic IPFS-like record hash
        claim.ipfsRecord = keccak256(abi.encodePacked(claimId, block.timestamp, block.number));

        // Update worker stats
        workers[claim.worker].verifiedDays++;

        totalVerifiedClaims++;

        emit ClaimSealed(claimId, claim.ipfsRecord, block.timestamp);
    }

    // ── SUPPLY CHAIN CERT ─────────────────────────────────────────────────────

    function issueCert(
        string calldata brand,
        string calldata productHash,
        address[] calldata workerWallets
    ) external returns (bytes32 certId) {
        require(workerWallets.length > 0, "No workers");

        // Validate each worker has verified claims
        uint256 eligibleCount = 0;
        for (uint i = 0; i < workerWallets.length; i++) {
            if (registeredWorkers[workerWallets[i]] && workers[workerWallets[i]].verifiedDays > 0) {
                eligibleCount++;
            }
        }
        require(eligibleCount * 100 / workerWallets.length >= 70, "< 70% workers verified");

        certId = keccak256(abi.encodePacked(brand, productHash, block.timestamp, msg.sender));

        certs[certId] = SupplyChainCert({
            id: certId,
            brand: brand,
            productHash: productHash,
            verifiedWorkers: workerWallets,
            issuedAt: block.timestamp,
            isValid: true
        });

        totalCerts++;
        emit CertIssued(certId, brand, eligibleCount);
    }

    // ── SLASH (OWNER ONLY) ────────────────────────────────────────────────────

    function slashVerifier(address verifier, bytes32 claimId) external onlyOwner {
        require(hasVerified[claimId][verifier], "Did not verify this claim");
        uint256 oldRep = workers[verifier].reputationScore;
        workers[verifier].reputationScore = oldRep > REP_LOSS_FALSE
            ? oldRep - REP_LOSS_FALSE : 0;
        emit ReputationChanged(verifier, oldRep, workers[verifier].reputationScore);
    }

    // ── VIEWS ─────────────────────────────────────────────────────────────────

    function getWorker(address wallet) external view returns (Worker memory) {
        return workers[wallet];
    }

    function getClaim(bytes32 claimId) external view returns (
        address worker, uint256 date, uint256 hours,
        address[] memory verifiers, ClaimStatus status, bytes32 ipfsRecord
    ) {
        WorkClaim storage c = claims[claimId];
        return (c.worker, c.date, c.hours, c.verifiers, c.status, c.ipfsRecord);
    }

    function getWorkerClaims(address wallet) external view returns (bytes32[] memory) {
        return workerClaims[wallet];
    }

    function getCreditProxy(address wallet) external view returns (
        uint256 verifiedDays, uint256 reputationScore, uint256 tenureMonths
    ) {
        Worker storage w = workers[wallet];
        verifiedDays = w.verifiedDays;
        reputationScore = w.reputationScore;
        tenureMonths = w.registeredAt > 0 ? (block.timestamp - w.registeredAt) / 30 days : 0;
    }
}
