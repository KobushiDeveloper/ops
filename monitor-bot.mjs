#!/usr/bin/env node
/**
 * BattleHood monitor bot (strażnik)
 * ------------------------------------------------------------------
 * Niezależny od bota operatora watchdog. Patrzy na kontrakty i portfel
 * operatora BEZPOŚREDNIO na blockchainie i alarmuje na Telegramie, gdy
 * coś jest nie tak. Najlepiej trzymać go na INNYM VPS-ie niż bot
 * operatora (strażnik nie może umrzeć razem z pilnowanym).
 *
 * Co pilnuje:
 *  1. Rundy się kręcą: jeśli currentEpoch nie ruszył a okno buffera
 *     minęło -> ALERT (bot operatora padł / brak gazu / RPC).
 *  2. Runda nierozliczona: poprzednia runda bez oracleCalled po
 *     closeTimestamp+buffer -> ALERT (gracze dostaną refundy, gra stoi).
 *  3. Gaz operatora: saldo < GAS_ALERT (domyślnie 0.02 ETH) -> ALERT.
 *  4. Pauza: kontrakt zapauzowany/odpauzowany -> ALERT.
 *  5. Skarbiec: treasuryAmount spadł (ktoś wywołał claimTreasury) -> INFO.
 *  6. RPC nie odpowiada 3 razy z rzędu -> ALERT.
 *  7. Heartbeat: raz na HEARTBEAT_HOURS (domyślnie 24h) wiadomość
 *     "wszystko gra" z podsumowaniem. Brak heartbeata = sprawdź strażnika.
 *
 * Test Telegrama:   node --env-file=.env monitor-bot.mjs test
 * Uruchomienie:     node --env-file=.env monitor-bot.mjs
 * Pod pm2:          pm2 start monitor-bot.mjs --name battlehood-monitor
 *
 * Wymagane env (patrz .env.example): RPC_URL, CONTRACTS,
 * OPERATOR_ADDRESS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 */

import { createPublicClient, defineChain, formatEther, http } from "viem";

const ABI = [
  { name: "currentEpoch", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "paused", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "bufferSeconds", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "treasuryAmount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
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
];

const {
  RPC_URL,
  CHAIN_ID = "1",
  CONTRACTS,
  OPERATOR_ADDRESS,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GAS_ALERT = "0.02",
  HEARTBEAT_HOURS = "24",
  CHECK_SECONDS = "30",
} = process.env;

if (!RPC_URL || !CONTRACTS || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error(
    "Brak konfiguracji. Wymagane: RPC_URL, CONTRACTS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (+ OPERATOR_ADDRESS zalecane).",
  );
  process.exit(1);
}

const chain = defineChain({
  id: Number(CHAIN_ID),
  name: "battlehood-target-chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const contracts = CONTRACTS.split(",").map((s) => s.trim()).filter(Boolean);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const now = () => Math.floor(Date.now() / 1000);

/* ---------------- telegram ---------------- */

async function sendTelegram(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (!res.ok) log("Telegram error:", res.status, await res.text());
  } catch (e) {
    log("Telegram unreachable:", e?.message ?? e);
  }
}

// cooldown, żeby jeden problem nie zasypał czatu
const lastSent = new Map();
async function alert(key, cooldownSec, text) {
  const prev = lastSent.get(key) ?? 0;
  if (now() - prev < cooldownSec) return;
  lastSent.set(key, now());
  log("ALERT:", text.replaceAll("\n", " | "));
  await sendTelegram(text);
}

/* ---------------- checks ---------------- */

const state = new Map(); // per contract: { epoch, epochSince, paused, treasury, buffer }
let rpcFails = 0;

async function checkContract(address) {
  const s = state.get(address) ?? {};
  const [epoch, paused, treasury] = await Promise.all([
    pub.readContract({ address, abi: ABI, functionName: "currentEpoch" }),
    pub.readContract({ address, abi: ABI, functionName: "paused" }),
    pub.readContract({ address, abi: ABI, functionName: "treasuryAmount" }),
  ]);
  if (s.buffer === undefined) {
    s.buffer = Number(await pub.readContract({ address, abi: ABI, functionName: "bufferSeconds" }));
  }
  const short = `${address.slice(0, 8)}...`;

  // 4. pauza
  if (s.paused !== undefined && s.paused !== paused) {
    await alert(`pause-${address}`, 60, paused
      ? `PAUZA: kontrakt ${short} zostal zapauzowany. Zaklady stoja, claim dziala.`
      : `WZNOWIONO: kontrakt ${short} odpauzowany, rundy wracaja.`);
  }
  s.paused = paused;

  // 5. skarbiec
  if (s.treasury !== undefined && treasury < s.treasury) {
    await alert(`treasury-${address}`, 60,
      `SKARBIEC: claimTreasury na ${short}: wyplacono ${formatEther(s.treasury - treasury)} ETH. Jesli to nie Ty: PANIKA (sprawdz multisig!).`);
  }
  s.treasury = treasury;

  if (epoch === 0n) {
    state.set(address, s);
    return; // przed genesis nie ma czego pilnować
  }

  // 1. rundy się kręcą?
  if (s.epoch !== String(epoch)) {
    s.epoch = String(epoch);
    s.epochSince = now();
  }
  const round = await pub.readContract({ address, abi: ABI, functionName: "rounds", args: [epoch] });
  const lockTs = Number(round[2]);
  if (!paused && now() > lockTs + s.buffer + 30) {
    await alert(`stalled-${address}`, 600,
      `RUNDY STOJA na ${short}: runda #${epoch} miala lock o ${new Date(lockTs * 1000).toISOString()}, buffer minal. Sprawdz bota operatora (proces? gaz? RPC?).`);
  }

  // 2. poprzednia rozliczona?
  if (epoch > 1n) {
    const prev = await pub.readContract({ address, abi: ABI, functionName: "rounds", args: [epoch - 1n] });
    const closeTs = Number(prev[3]);
    const oracleCalled = prev[13];
    if (!oracleCalled && closeTs > 0 && now() > closeTs + s.buffer + 30) {
      await alert(`unsettled-${address}`, 600,
        `RUNDA NIEROZLICZONA na ${short}: #${epoch - 1n} bez ceny zamkniecia po bufferze. Gracze dostana refundy; przywroc bota i pozwol rundom ruszyc od nowa.`);
    }
  }

  state.set(address, s);
}

async function checkOperatorGas() {
  if (!OPERATOR_ADDRESS) return;
  const bal = await pub.getBalance({ address: OPERATOR_ADDRESS });
  const eth = Number(formatEther(bal));
  if (eth < Number(GAS_ALERT)) {
    await alert("gas", 6 * 3600,
      `GAZ NA WYCZERPANIU: portfel operatora ${OPERATOR_ADDRESS.slice(0, 8)}... ma ${eth.toFixed(4)} ETH (prog ${GAS_ALERT}). Doladuj, bo rundy stana.`);
  }
  return eth;
}

async function heartbeat() {
  try {
    const gas = await checkOperatorGas();
    const lines = ["BattleHood monitor: wszystko gra."];
    for (const address of contracts) {
      const epoch = await pub.readContract({ address, abi: ABI, functionName: "currentEpoch" });
      const treasury = await pub.readContract({ address, abi: ABI, functionName: "treasuryAmount" });
      lines.push(`${address.slice(0, 8)}...: runda #${epoch}, skarbiec ${formatEther(treasury)} ETH`);
    }
    if (gas !== undefined) lines.push(`Gaz operatora: ${gas.toFixed(4)} ETH`);
    await sendTelegram(lines.join("\n"));
  } catch (e) {
    log("Heartbeat error:", e?.message ?? e);
  }
}

async function tick() {
  try {
    for (const c of contracts) await checkContract(c);
    await checkOperatorGas();
    if (rpcFails >= 3) await sendTelegram("RPC znowu odpowiada, monitoring wrocil do normy.");
    rpcFails = 0;
  } catch (e) {
    rpcFails += 1;
    log(`RPC/blad (${rpcFails}x):`, e?.shortMessage ?? e?.message ?? e);
    if (rpcFails === 3) {
      await alert("rpc", 900,
        `RPC NIE ODPOWIADA (3 proby z rzedu): ${RPC_URL.slice(0, 40)}... Monitoring jest slepy; sprawdz dostawce RPC.`);
    }
  }
}

/* ---------------- start ---------------- */

if (process.argv[2] === "test") {
  sendTelegram("Test BattleHood monitor: Telegram dziala. Jesli to czytasz, alerty beda przychodzic tutaj.")
    .then(() => { log("Wyslano wiadomosc testowa."); process.exit(0); })
    .catch(() => process.exit(1));
} else {
  log(`Monitor wystartowal. Kontrakty: ${contracts.join(", ")}; operator: ${OPERATOR_ADDRESS ?? "(nie podano)"}`);
  void sendTelegram("BattleHood monitor uruchomiony. Pilnuje rund, gazu i skarbca.");
  setInterval(tick, Number(CHECK_SECONDS) * 1000);
  setInterval(heartbeat, Number(HEARTBEAT_HOURS) * 3600 * 1000);
  void tick();
}
