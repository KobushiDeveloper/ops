#!/usr/bin/env node
/**
 * BattleHood operator bot (wersja Robinhood Chain, z wlasna wyrocznia)
 * ------------------------------------------------------------------
 * Robi DWIE rzeczy w rytmie rund:
 *  1. Wpycha swieza cene z gieldy (Binance -> OKX fallback) do kontraktu
 *     BattleHoodOracle danego assetu (updateAnswer, cena x 1e8).
 *  2. Wola executeRound() na kontrakcie BattleHoodPrediction
 *     (lock biezacej rundy + rozliczenie poprzedniej + otwarcie nowej).
 *
 * Genesis:   node --env-file=.env operator-bot.mjs genesis   (2x, w odstepie 5 min)
 * Petla 24/7: node --env-file=.env operator-bot.mjs
 *
 * Env (patrz .env.example): RPC_URL, CHAIN_ID, OPERATOR_KEY,
 * CONTRACTS, ORACLES, SYMBOLS (te trzy listy w TEJ SAMEJ kolejnosci),
 * opcjonalnie TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 *
 * Robinhood Chain (4663): transakcje legacy (gasPrice), bloki ~101 s.
 * Bot sam pobiera gasPrice przed kazda transakcja.
 */

import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PREDICTION_ABI = [
  { name: "currentEpoch", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "genesisStartOnce", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "genesisLockOnce", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "paused", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "bufferSeconds", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    name: "rounds", type: "function", stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      { type: "int256" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint256" }, { type: "bool" },
    ],
  },
  { name: "genesisStartRound", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "genesisLockRound", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "executeRound", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
];

const ORACLE_ABI = [
  { name: "updateAnswer", type: "function", stateMutability: "nonpayable", inputs: [{ type: "int256" }], outputs: [] },
  { name: "latestRound", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }] },
];

const COINFLIP_ABI = [
  { name: "totalFlips", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "firstUnsettled", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "settleNext", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
];

const {
  RPC_URL, CHAIN_ID, OPERATOR_KEY, CONTRACTS, ORACLES, SYMBOLS,
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, COINFLIP,
} = process.env;

if (!RPC_URL || !CHAIN_ID || !OPERATOR_KEY || !CONTRACTS || !ORACLES || !SYMBOLS) {
  console.error("Brak konfiguracji. Wymagane: RPC_URL, CHAIN_ID, OPERATOR_KEY, CONTRACTS, ORACLES, SYMBOLS (patrz .env.example).");
  process.exit(1);
}

const predictions = CONTRACTS.split(",").map((s) => s.trim()).filter(Boolean);
const oracles = ORACLES.split(",").map((s) => s.trim()).filter(Boolean);
const symbols = SYMBOLS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
if (predictions.length !== oracles.length || predictions.length !== symbols.length) {
  console.error("CONTRACTS, ORACLES i SYMBOLS musza miec tyle samo pozycji, w tej samej kolejnosci.");
  process.exit(1);
}
const markets = predictions.map((p, i) => ({ prediction: p, oracle: oracles[i], symbol: symbols[i] }));

const chain = defineChain({
  id: Number(CHAIN_ID),
  name: "robinhood-chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const account = privateKeyToAccount(OPERATOR_KEY.startsWith("0x") ? OPERATOR_KEY : `0x${OPERATOR_KEY}`);
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });

const log = (...a) => console.log(new Date().toISOString(), ...a);
const now = () => Math.floor(Date.now() / 1000);

/* ---------------- telegram (opcjonalny) ---------------- */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch { /* nie blokujemy bota */ }
}
const tgLast = new Map();
async function tgAlert(key, cooldownSec, text) {
  const t = now();
  if (t - (tgLast.get(key) ?? 0) < cooldownSec) return;
  tgLast.set(key, t);
  await sendTelegram(text);
}

/* ---------------- ceny z gieldy ---------------- */
async function fetchJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Zwraca cene w formacie oracle: int z 8 miejscami dziesietnymi.
async function getPriceE8(symbol) {
  try {
    const d = await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
    return BigInt(Math.round(Number(d.price) * 1e8));
  } catch {
    const d = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT`);
    const last = d?.data?.[0]?.last;
    if (!last) throw new Error(`brak ceny dla ${symbol}`);
    return BigInt(Math.round(Number(last) * 1e8));
  }
}

/* ---------------- transakcje (legacy gas: Robinhood Chain) ---------------- */
async function write(address, abi, functionName, args = []) {
  const gasPrice = ((await pub.getGasPrice()) * 3n);
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account, gasPrice });
  const hash = await wallet.writeContract({ ...request, gasPrice });
  log(`${functionName}(${args.join(",")}) @ ${address.slice(0, 10)}... -> ${hash}`);
  await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
  log(`${functionName} @ ${address.slice(0, 10)}... potwierdzone`);
  return hash;
}

async function pushPrice(market) {
  const price = await getPriceE8(market.symbol);
  await write(market.oracle, ORACLE_ABI, "updateAnswer", [price]);
  log(`${market.symbol}: cena ${Number(price) / 1e8} USD wypchnieta do oracle`);
}

/* ---------------- genesis ---------------- */
async function genesis() {
  for (const m of markets) {
    const started = await pub.readContract({ address: m.prediction, abi: PREDICTION_ABI, functionName: "genesisStartOnce" });
    if (!started) {
      await pushPrice(m); // swieza cena w oracle przed startem
      await write(m.prediction, PREDICTION_ABI, "genesisStartRound");
      log(`${m.symbol}: genesis start OK. Odczekaj 5 minut i uruchom 'genesis' ponownie.`);
      continue;
    }
    const locked = await pub.readContract({ address: m.prediction, abi: PREDICTION_ABI, functionName: "genesisLockOnce" });
    if (!locked) {
      const epoch = await pub.readContract({ address: m.prediction, abi: PREDICTION_ABI, functionName: "currentEpoch" });
      const round = await pub.readContract({ address: m.prediction, abi: PREDICTION_ABI, functionName: "rounds", args: [epoch] });
      if (now() < Number(round[2])) {
        log(`${m.symbol}: za wczesnie na genesisLockRound (lock o ${new Date(Number(round[2]) * 1000).toISOString()})`);
        continue;
      }
      await pushPrice(m);
      await write(m.prediction, PREDICTION_ABI, "genesisLockRound");
      log(`${m.symbol}: genesis lock OK. Bot moze przejsc w tryb petli.`);
    } else {
      log(`${m.symbol}: genesis juz zakonczony.`);
    }
  }
}

/* ---------------- petla ---------------- */
const busy = new Set();

async function tick(market) {
  if (busy.has(market.prediction)) return;
  busy.add(market.prediction);
  try {
    const [paused, started, locked] = await Promise.all([
      pub.readContract({ address: market.prediction, abi: PREDICTION_ABI, functionName: "paused" }),
      pub.readContract({ address: market.prediction, abi: PREDICTION_ABI, functionName: "genesisStartOnce" }),
      pub.readContract({ address: market.prediction, abi: PREDICTION_ABI, functionName: "genesisLockOnce" }),
    ]);
    if (paused) return;

    // AUTO-GENESIS: fresh contract? the bot bootstraps it by itself.
    // Phase 1: push a price and start the first round.
    if (!started) {
      log(`${market.symbol}: swiezy kontrakt, robie genesisStartRound...`);
      await pushPrice(market);
      await write(market.prediction, PREDICTION_ABI, "genesisStartRound");
      await sendTelegram(`GENESIS 1/2 (${market.symbol}): pierwsza runda otwarta. Lock za ~5 min, bot dokonczy sam.`);
      return;
    }
    // Phase 2: after the first interval, lock it and open round #2.
    if (!locked) {
      const gEpoch = await pub.readContract({ address: market.prediction, abi: PREDICTION_ABI, functionName: "currentEpoch" });
      const gRound = await pub.readContract({ address: market.prediction, abi: PREDICTION_ABI, functionName: "rounds", args: [gEpoch] });
      if (now() >= Number(gRound[2])) {
        log(`${market.symbol}: robie genesisLockRound...`);
        await pushPrice(market);
        await write(market.prediction, PREDICTION_ABI, "genesisLockRound");
        await sendTelegram(`GENESIS 2/2 (${market.symbol}): rundy wystartowaly, arena zyje!`);
      } else {
        log(`${market.symbol}: czekam na lock genesis (${Number(gRound[2]) - now()}s)...`);
      }
      return;
    }

    const epoch = await pub.readContract({ address: market.prediction, abi: PREDICTION_ABI, functionName: "currentEpoch" });
    const round = await pub.readContract({ address: market.prediction, abi: PREDICTION_ABI, functionName: "rounds", args: [epoch] });
    const lockTs = Number(round[2]);
    const buffer = Number(await pub.readContract({ address: market.prediction, abi: PREDICTION_ABI, functionName: "bufferSeconds" }));
    const t = now();

    if (t >= lockTs && t <= lockTs + buffer - 5) {
      // swieza cena -> executeRound (oracle roundId musi urosnac miedzy rundami)
      await pushPrice(market);
      await write(market.prediction, PREDICTION_ABI, "executeRound");
    } else if (t > lockTs + buffer) {
      log(`${market.symbol}: UWAGA, przegapione okno buffera rundy #${epoch}.`);
      await tgAlert(`buffer-${market.prediction}`, 600, `OPERATOR: przegapione okno buffera rundy #${epoch} (${market.symbol}). Rundy stoja, sprawdz gaz/RPC.`);
    }
  } catch (e) {
    log(`${market.symbol}: blad:`, e?.shortMessage ?? e?.message ?? e);
    await tgAlert(`err-${market.prediction}`, 600, `OPERATOR: blad (${market.symbol}): ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
  } finally {
    busy.delete(market.prediction);
  }
}

async function loop() {
  const balance = await pub.getBalance({ address: account.address });
  log(`Bot operatora wystartowal. Portfel ${account.address}, gaz ${Number(balance) / 1e18} ETH`);
  log(`Rynki: ${markets.map((m) => `${m.symbol} pred=${m.prediction.slice(0, 10)}... oracle=${m.oracle.slice(0, 10)}...`).join(" | ")}`);
  await sendTelegram(`Bot operatora wystartowal (Robinhood Chain). Gaz: ${(Number(balance) / 1e18).toFixed(4)} ETH, rynki: ${markets.map((m) => m.symbol).join(", ")}.`);
  if (balance === 0n) await sendTelegram("UWAGA: zero gazu na portfelu operatora! Rundy nie ruszą.");
  // UWAGA na czas bloku ~101 s: transakcje sa wolne, wiec okno buffera w
  // kontrakcie na tej sieci powinno byc szerokie (patrz runbook: buffer 240).
  setInterval(() => markets.forEach((m) => void tick(m)), 10_000);
  if (COINFLIP) {
    log(`Coin flip keeper wlaczony dla ${COINFLIP}`);
    setInterval(() => void settleCoinflips(), 30_000);
  }
}

// Auto-rozlicza oczekujace rzuty moneta (gracz nie musi klikac "reveal").
let coinBusy = false;
async function settleCoinflips() {
  if (coinBusy || !COINFLIP) return;
  coinBusy = true;
  try {
    const [total, first] = await Promise.all([
      pub.readContract({ address: COINFLIP, abi: COINFLIP_ABI, functionName: "totalFlips" }),
      pub.readContract({ address: COINFLIP, abi: COINFLIP_ABI, functionName: "firstUnsettled" }),
    ]);
    if (total > first) {
      await write(COINFLIP, COINFLIP_ABI, "settleNext", [20n]);
    }
  } catch (e) {
    log("coinflip settle blad:", e?.shortMessage ?? e?.message ?? e);
  } finally {
    coinBusy = false;
  }
}

if (process.argv[2] === "genesis") {
  genesis().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
  loop();
}
