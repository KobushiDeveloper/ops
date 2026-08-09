# BattleHood: deploy botów na Railway (5 minut klikania)

**AUTO-GENESIS: nie ma już osobnego kroku "genesis".** Bot po starcie sam
wykrywa świeże kontrakty, sam robi obie fazy rozruchu i przechodzi w tryb
kręcenia rund. Ty tylko uruchamiasz serwis z właściwymi zmiennymi.

Dwa serwisy na Railway z tego samego foldera `ops/`: jeden kręci rundami
(operator), drugi pilnuje i alarmuje (monitor). Klucz operatora wpisujesz
TYLKO Ty, w panelu Railway (Variables) — nigdzie indziej.

## Krok 1 — repo

Wrzuć folder `ops/` (te pliki: operator-bot.mjs, monitor-bot.mjs,
package.json) na GitHub jako repo, albo użyj Railway "Deploy from local".
Railway sam wykryje Node i zrobi `npm install` (pobierze viem).

## Krok 2 — serwis OPERATOR

1. Railway → New Project → Deploy from GitHub repo (wskaż to repo)
2. Settings → **Start Command**: `npm run operator`
3. Zakładka **Variables** → dodaj:

```
RPC_URL=twoj-rpc-robinhood-chain
CHAIN_ID=4663
CONTRACTS=0x5371BA509097481EeDbabcde257b7B401BB7745C,0x30eBDf4215ba47D891A8Ae6115De5391730fC4D5,0x1Dfc4108d57fe3c42B699de679956526C886a66B,0x7c0B0f86609eFE7c87F2db0Ce8A131a61bD346e0
ORACLES=0x101f21db94CaDbf1C57Aa8F05cddC53506E037CA,0x7a31e232DBE4AECf4728E570dde0320Ee87091Ec,0xcbf874cBcEc5a0A08fA65DdB8D04D8B273955fa7,0x11e4f2540b03466a7eEd96e9A9716ca626b24Ca0
SYMBOLS=BTC,ETH,SOL,XRP
OPERATOR_KEY=0x...        # klucz portfela bota — wpisujesz TYLKO tutaj
OPERATOR_ADDRESS=0x...    # adres tego samego portfela
TELEGRAM_BOT_TOKEN=...    # opcjonalne alerty
TELEGRAM_CHAT_ID=...
```

## Krok 3 — start i auto-genesis

Po deployu z powyższymi zmiennymi bot W LOGACH sam zamelduje kolejno:
"genesisStartRound..." -> po ~5-8 min "genesisLockRound..." ->
"rundy wystartowaly". Jak masz podpięty Telegram, dostaniesz
"GENESIS 1/2" i "GENESIS 2/2" dla każdego rynku. Zero działań ręcznych.

Uwaga: portfel operatora musi mieć ETH na gaz na Robinhood Chain (~0.05).

## Krok 4 — serwis MONITOR (strażnik + alerty Telegram)

1. W tym samym projekcie → New Service → z tego samego repo
2. Start Command: `npm run monitor`
3. Variables: te same co operator (RPC_URL, CHAIN_ID, CONTRACTS, ORACLES,
   SYMBOLS, OPERATOR_ADDRESS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) —
   monitorowi NIE dawaj OPERATOR_KEY, on tylko czyta.

## Krok 5 — sprawdzenie

- Logi operatora: co ~5-8 min "executeRound ... potwierdzone" dla każdego rynku
- Telegram: wiadomość startowa, potem alerty tylko gdy coś nie tak
- Na stronie battlehood.fun/onchain pule zaczną rosnąć, gdy gracze obstawią

Jeśli logi krzyczą "za wczesnie" / "brak genesis" — nie zrobiłeś kroku 3
(genesis) albo nie minął jeszcze pierwszy interwał. Daj botowi jeden pełny
cykl.
