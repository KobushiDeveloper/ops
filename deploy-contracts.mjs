#!/usr/bin/env node
/**
 * BattleHood: automatyczny deploy WSZYSTKICH kontraktow jedna komenda.
 * ------------------------------------------------------------------
 * Dla kazdego assetu z listy SYMBOLS wdraza pare:
 *   1. BattleHoodOracle (updater = OPERATOR_ADDRESS)
 *   2. BattleHoodPrediction (oracle = adres z kroku 1, buffer 240,
 *      allowance 600, fee 500 = 5%, minBet 0.001 ETH)
 * Na koncu wypisuje gotowe linie CONTRACTS= i ORACLES= do wklejenia
 * w .env oraz liste adresow do wyslania do integracji strony.
 *
 * Przygotowanie (raz):
 *   npm install viem solc@0.8.24
 *   # skrypt zaklada, ze pliki .sol leza w ../contracts/ (tak jak w zipie)
 *
 * Env (dopisz do .env):
 *   DEPLOYER_KEY=0x...      # klucz portfela, ktory placi za deploy (moze byc operator)
 *   ADMIN_ADDRESS=0x...     # kto ma rzadzic kontraktami (multisig/Twoj cold wallet)
 *   OPERATOR_ADDRESS=0x...  # adres portfela bota (updater cen + kreci rundami)
 *   RPC_URL=..., CHAIN_ID=4663, SYMBOLS=BTC,ETH,SOL,XRP
 *
 * Uruchomienie:
 *   node --env-file=.env deploy-contracts.mjs
 *
 * Koszt: 8 transakcji deploy (4 oracle + 4 predykcje). Przy wolnych
 * blokach Robinhood Chain (~101 s) calosc potrwa ~15-25 minut.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import solc from "solc";

const { RPC_URL, CHAIN_ID = "4663", DEPLOYER_KEY, ADMIN_ADDRESS, OPERATOR_ADDRESS, SYMBOLS = "BTC,ETH,SOL,XRP" } = process.env;
if (!RPC_URL || !DEPLOYER_KEY || !ADMIN_ADDRESS || !OPERATOR_ADDRESS) {
  console.error("Wymagane env: RPC_URL, DEPLOYER_KEY, ADMIN_ADDRESS, OPERATOR_ADDRESS (+ CHAIN_ID, SYMBOLS).");
  process.exit(1);
}

const __dir = dirname(fileURLToPath(import.meta.url));
const symbols = SYMBOLS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

/* ---------- kompilacja (solc 0.8.24, optimizer 200) ---------- */
function compile(fileName) {
  const source = readFileSync(join(__dir, "..", "contracts", fileName), "utf8");
  const input = {
    language: "Solidity",
    sources: { [fileName]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) {
    console.error(errors.map((e) => e.formattedMessage).join("\n"));
    process.exit(1);
  }
  const contracts = out.contracts[fileName];
  // bierzemy kontrakt o najwiekszym bytecode (glowny w pliku)
  const name = Object.keys(contracts).sort(
    (a, b) => contracts[b].evm.bytecode.object.length - contracts[a].evm.bytecode.object.length,
  )[0];
  return { abi: contracts[name].abi, bytecode: `0x${contracts[name].evm.bytecode.object}`, name };
}

/* ---------- siec ---------- */
const chain = defineChain({
  id: Number(CHAIN_ID),
  name: "robinhood-chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(DEPLOYER_KEY.startsWith("0x") ? DEPLOYER_KEY : `0x${DEPLOYER_KEY}`);
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });

async function deploy(artifact, args, label) {
  const gasPrice = await pub.getGasPrice();
  console.log(`\n[deploy] ${label} (${artifact.name})...`);
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args, gasPrice });
  console.log(`  tx: ${hash} (czekam na potwierdzenie, na tej sieci ~2 min)`);
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (!rcpt.contractAddress) throw new Error("brak adresu kontraktu w receipcie");
  console.log(`  OK: ${rcpt.contractAddress}`);
  return rcpt.contractAddress;
}

/* ---------- main ---------- */
const oracleArt = compile("BattleHoodOracle.sol");
const predArt = compile("BattleHoodPrediction.sol");

const balance = await pub.getBalance({ address: account.address });
console.log(`Deployer: ${account.address}, saldo ${Number(balance) / 1e18} ETH, siec ${CHAIN_ID}`);
console.log(`Assety: ${symbols.join(", ")} (8 deployow, ~15-25 min na Robinhood Chain)`);
if (balance < parseEther("0.02")) {
  console.warn("UWAGA: malo gazu na deployerze (zalecane min 0.02 ETH). Kontynuuje...");
}

const results = [];
for (const sym of symbols) {
  const oracle = await deploy(oracleArt, [`${sym} / USD`, OPERATOR_ADDRESS], `${sym} oracle`);
  const prediction = await deploy(
    predArt,
    [
      oracle,               // _oracle
      ADMIN_ADDRESS,        // _adminAddress
      OPERATOR_ADDRESS,     // _operatorAddress
      300n,                 // _intervalSeconds
      240n,                 // _bufferSeconds  (wolne bloki Robinhood Chain!)
      parseEther("0.001"),  // _minBetAmount
      600n,                 // _oracleUpdateAllowance
      500n,                 // _treasuryFee = 5%
    ],
    `${sym} prediction`,
  );
  results.push({ sym, oracle, prediction });
}

console.log("\n================ GOTOWE ================");
console.log("Wklej do .env (dla operator-bot i monitor-bot):\n");
console.log(`CONTRACTS=${results.map((r) => r.prediction).join(",")}`);
console.log(`ORACLES=${results.map((r) => r.oracle).join(",")}`);
console.log(`SYMBOLS=${results.map((r) => r.sym).join(",")}`);
console.log("\nWyslij do integracji strony (battlehood.fun/onchain):");
for (const r of results) console.log(`  ${r.sym}: ${r.prediction}`);
console.log("\nNastepne kroki: node operator-bot.mjs genesis (2x w odstepie 5 min), potem pm2 start.");
