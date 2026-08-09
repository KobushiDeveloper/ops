# BattleHood: monitoring on-chain z alertami na Telegram

Dwa procesy, jeden plik konfiguracyjny:

| Plik | Rola | Gdzie trzymac |
|---|---|---|
| `operator-bot.mjs` | KRECI rundami (executeRound co 300 s) | VPS nr 1 |
| `monitor-bot.mjs` | PILNUJE, czy wszystko gra i alarmuje na Telegramie | najlepiej VPS nr 2 (straznik nie moze umrzec razem z pilnowanym; na start moze byc ten sam VPS) |

## Co monitor wykrywa i wysyla na Telegram

1. **Rundy stoja** - currentEpoch nie ruszyl a okno buffera minelo
   (padl bot operatora / brak gazu / RPC). Alert co max 10 min.
2. **Runda nierozliczona** - poprzednia runda bez ceny zamkniecia po
   bufferze (gracze dostana refundy).
3. **Konczy sie gaz** operatora (prog GAS_ALERT, domyslnie 0.02 ETH).
4. **Pauza / odpauzowanie** kontraktu.
5. **Wyplata ze skarbca** (claimTreasury) - jesli to nie Ty, wiesz od razu.
6. **RPC nie odpowiada** (3 proby z rzedu).
7. **Heartbeat** raz na dobe: "wszystko gra" + numer rundy, skarbiec, gaz.
   Brak heartbeata = sprawdz, czy monitor zyje.

Bot operatora dodatkowo sam wysyla alert, gdy ma blad transakcji albo
przegapi okno buffera (te same zmienne TELEGRAM_*).

## Konfiguracja Telegrama (5 minut)

1. Napisz na Telegramie do **@BotFather** -> `/newbot` -> nazwa np.
   `BattleHood Alerts` -> dostajesz **token** (`123456:AA...`). Wklej do
   `.env` jako `TELEGRAM_BOT_TOKEN`.
2. Poznaj swoje **chat id**: napisz do **@userinfobot** - odpisze Twoim id
   (np. `8351095206`). Wklej jako `TELEGRAM_CHAT_ID`.
3. WAZNE: napisz cokolwiek do SWOJEGO nowego bota (np. "start"), bo bot
   nie moze pisac pierwszy.
4. Chcesz alerty na grupie/kanale zespolu? Dodaj bota do grupy, napisz na
   niej wiadomosc, wejdz na
   `https://api.telegram.org/bot<TOKEN>/getUpdates` i odczytaj `chat.id`
   (dla grup bedzie ujemne, np. `-100123...`) - to wklejasz jako
   `TELEGRAM_CHAT_ID`.
5. Test: `node --env-file=.env monitor-bot.mjs test` - ma przyjsc
   wiadomosc testowa.

## Uruchomienie od zera (VPS, Ubuntu)

```bash
# 1. Na serwerze: zainstaluj Node 20+ i pm2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# 2. Wgraj folder ops/ na serwer (z Twojego komputera):
#    scp -r ops/ root@IP-SERWERA:/opt/battlehood/

# 3. Na serwerze:
cd /opt/battlehood/ops
npm init -y && npm install viem
cp .env.example .env
nano .env        # uzupelnij RPC, kontrakty, klucz operatora, telegram

# 4. Test telegrama:
node --env-file=.env monitor-bot.mjs test

# 5. Start obu botow pod pm2 (auto-restart + start po reboocie):
pm2 start "node --env-file=.env operator-bot.mjs" --name battlehood-operator
pm2 start "node --env-file=.env monitor-bot.mjs" --name battlehood-monitor
pm2 save && pm2 startup   # wykonaj komende, ktora wypisze

# Podglad logow:
pm2 logs battlehood-monitor
```

## Symulacja awarii (zrob to raz na testnecie!)

1. `pm2 stop battlehood-operator` -> po ~35 s od locka rundy monitor ma
   wyslac alert "RUNDY STOJA".
2. `pm2 start battlehood-operator` -> rundy wracaja (stara runda pojdzie
   w refund, to normalne).
3. Wyslij prawie caly gaz z portfela operatora -> alert o gazie.
Jesli te trzy alerty przyszly, monitoring dziala.
