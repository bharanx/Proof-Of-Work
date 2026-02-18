const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying ProofOfWork with account:", deployer.address);
  console.log("Account balance:", (await deployer.provider.getBalance(deployer.address)).toString());

  const ProofOfWork = await ethers.getContractFactory("ProofOfWork");
  const pow = await ProofOfWork.deploy();
  await pow.waitForDeployment();

  const address = await pow.getAddress();
  console.log("\n✅ ProofOfWork deployed to:", address);
  console.log("   Network:", hre.network.name);
  console.log("   TX:", pow.deploymentTransaction()?.hash);
  console.log("\nAdd to backend/.env:");
  console.log(`   CONTRACT_ADDRESS=${address}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
