# BattleHood: runbook launchu mainnet (Robinhood Chain)

## Robinhood Chain (ID 4663): fakty, ktore zmieniaja parametry

- **Chain ID:** 4663, gaz placony w ETH, transakcje **legacy (gasPrice)** —
  boty juz to obsluguja.
- **Explorer:** robinhoodchain.blockscout.com (weryfikacja kodu: Blockscout
  "Verify & publish").
- **Czas bloku ~101 s** — transakcja potwierdza sie do ~2 minut. DLATEGO
  przy deployu predykcji uzyj **_bufferSeconds = 240** (nie 30!) i
  **_oracleUpdateAllowance = 600** (nie 300). W praktyce rundy beda
  rozliczac sie co ~6-8 minut zamiast rowno 5 — to normalne na tej sieci.
- **Brak Chainlinka** — cene dostarcza wlasny kontrakt `BattleHoodOracle.sol`
  (para: 1 oracle + 1 predykcja na asset). Ceny wpycha bot operatora z
  Binance/OKX przed kazdym executeRound. UCZCIWA KOMUNIKACJA: gracze ufaja
  Twojemu botowi cenowemu; napisz to w docs. Gdy Chainlink wejdzie na siec,
  wdrozysz predykcje ponownie z jego feedem.

## Kolejnosc deployu na Robinhood Chain (Remix, solc 0.8.24, optimizer 200)

Dla KAZDEGO assetu (BTC, ETH, SOL, XRP):

1. Deploy `BattleHoodOracle.sol`:
   - `_description`: np. "BTC / USD"
   - `_updater`: adres portfela OPERATORA (bota)
2. Deploy `BattleHoodPrediction.sol`:
   - `_oracle`: adres oracle z kroku 1
   - `_adminAddress`: Twoj admin/multisig
   - `_operatorAddress`: adres portfela operatora
   - `_intervalSeconds`: `300`
   - `_bufferSeconds`: `240`
   - `_minBetAmount`: `1000000000000000` (0.001 ETH)
   - `_oracleUpdateAllowance`: `600`
   - `_treasuryFee`: `500` (5%)
3. Zweryfikuj oba kontrakty na robinhoodchain.blockscout.com.

Kolejnosc jest wazna. Nie przeskakuj etapow ponizej: kazdy odhacza warunki
wejscia do nastepnego. Real money = zero improwizacji.

## Etap 0: przygotowanie portfeli (1 dzień)

- [ ] **Portfel ADMIN**: świeży adres, docelowo multisig (np. Safe, 2/3 podpisów:
      Ty + zaufana osoba + zapasowy klucz w sejfie). Admin może: zmieniać fee
      (max 10%), pauzować, wypłacać skarbiec, zmieniać operatora.
- [ ] **Portfel OPERATOR**: świeży adres, trzyma wyłącznie gaz (0.05-0.1 ETH).
      Klucz trafi na VPS-a bota. Kompromitacja operatora NIE daje dostępu do
      środków graczy ani skarbca (może tylko kręcić/zatrzymać rundy).
- [ ] **Portfel DEPLOYER**: może być ten sam co admin (konstruktor przyjmuje
      adres admina jawnie), ale czyściej: osobny, użyty raz.
- [ ] Klucze zapisane offline (papier/metal), nigdy w chmurze, mailu, czacie.

## Etap 1: parametry sieci Robinhood Chain

Z oficjalnej dokumentacji Robinhood Chain (w dniu launchu) zbierz:

- [ ] RPC URL (mainnet + testnet)
- [ ] Chain ID (mainnet + testnet)
- [ ] Block explorer URL
- [ ] Adresy feedów cen (Chainlink lub inny oracle dostępny na tej sieci)
      dla: BTC/USD, ETH/USD, SOL/USD, XRP/USD

UWAGA: kontrakt wymaga oracle w stylu Chainlink AggregatorV3. Jeśli w dniu
launchu Robinhood Chain nie ma feedów Chainlink dla któregoś assetu,
launchujesz tylko te, które mają feed (kontrakt = 1 asset, więc to nie blokuje
pozostałych).

## Etap 2: testnet (minimum 1 tydzień)

- [ ] Deploy 1 kontraktu (BTC) na testnecie przez Remix: solc 0.8.24,
      optimizer 200, parametry: oracle, admin, operator, 300, 30,
      minBet (np. 0.001 ETH = 1000000000000000 wei), 300, 500.
- [ ] `genesisStartRound()` -> po 5 min `genesisLockRound()` (albo
      `node operator-bot.mjs genesis` dwukrotnie).
- [ ] Bot operatora na VPS: `node --env-file=.env operator-bot.mjs`,
      pod pm2/systemd z auto-restartem.
- [ ] Test pełnego cyklu przez MINIMUM 200 rund (ok. 17 h) bez przerwy:
      - [ ] zakłady z 2-3 portfeli po obu stronach
      - [ ] claim wygranych: kwoty zgadzają się z formułą (95% puli / pula wygranych)
      - [ ] skarbiec: `treasuryAmount` rośnie o 5% pul, `claimTreasury()` działa
      - [ ] scenariusz awarii: zatrzymaj bota na 2 min -> rundy wypadają
            z buffera -> `refundable` = true -> gracze odzyskują stawki
      - [ ] pauza: `setPaused(true)` blokuje zakłady, `claim` nadal działa
- [ ] Podłącz stronę do testnetu (sekrety ONCHAIN_* na stronie) i przeklikaj
      cały UI prawdziwym MetaMaskiem.

## Etap 3: audyt bezpieczeństwa (2-6 tygodni)

Szczegóły i pakiet dla audytorów: `ops/AUDIT-PACKAGE.md`.

- [ ] Samokontrola przed audytem (tanio wyłapuje 80% problemów):
      - [ ] `slither contracts/BattleHoodPrediction.sol` (statyczna analiza, darmowa)
      - [ ] `solc --optimize --bin` kompiluje bez warningów
      - [ ] przejdź checklistę inwariantów z AUDIT-PACKAGE.md ręcznie
- [ ] Audyt zewnętrzny: wyślij pakiet do 2-3 firm, porównaj wyceny.
      Realny koszt dla kontraktu tej wielkości (ok. 430 linii, fork znanego
      wzorca PancakeSwap V2): zwykle 5-15 tys. USD, 1-2 tygodnie pracy.
      Tańsza alternatywa na start: audyt konkursowy (Code4rena/Sherlock/
      Cantina) albo solo-audytor z portfolio.
- [ ] Wszystkie znaleziska HIGH/CRITICAL naprawione i re-audytowane.
- [ ] Raport z audytu opublikowany (link na stronie = zaufanie graczy).

## Etap 4: deploy mainnet (1 dzień, na spokojnie)

- [ ] Deploy 4 kontraktów (BTC, ETH, SOL, XRP) z parametrami jak na testnecie,
      admin = MULTISIG, operator = portfel bota.
- [ ] Zweryfikuj kod źródłowy na explorerze (verify & publish w Remix/explorer),
      żeby każdy mógł przeczytać kontrakt.
- [ ] Genesis obu faz na każdym kontrakcie.
- [ ] Bot na VPS przełączony na mainnet (nowy .env), pm2 z auto-restartem
      i drugim VPS-em zapasowym (failover ręczny wystarczy na start).
- [ ] Podmień sekrety strony: ONCHAIN_RPC_URL, ONCHAIN_CHAIN_ID,
      ONCHAIN_CHAIN_NAME, ONCHAIN_EXPLORER_URL, ONCHAIN_CONTRACTS
      (JSON: {"BTC":"0x..","ETH":"0x..","SOL":"0x..","XRP":"0x.."}),
      redeploy strony -> zakładka Mainnet arena ożywa automatycznie.
- [ ] Soft launch: minBet nisko, ogłoszenie tylko na Telegramie, 48 h
      obserwacji zanim ruszy szerszy marketing.

## Etap 5: operacje dzień-po-dniu

- [ ] Monitoring: uruchom `monitor-bot.mjs` (alerty na Telegram: rundy
      stoją, gaz, pauza, skarbiec, RPC; instrukcja w `ops/MONITORING.md`),
      najlepiej na osobnym VPS-ie.
- [ ] Alert na saldo gazu operatora < 0.02 ETH (robi to monitor-bot).
- [ ] Skarbiec: `claimTreasury()` wywołuj z multisiga regularnie (nie trzymaj
      dużych kwot na kontrakcie ponad potrzebę).
- [ ] Plan awaryjny: przy podejrzeniu exploita `setPaused(true)` ze
      wszystkich kontraktów (zakłady stają, claim działa dalej), komunikat
      na Telegram/X, analiza, decyzja.

## Etap 6: prawo (nie pomijaj tego)

Gra na prawdziwe pieniądze o wynik ceny = w wielu jurysdykcjach hazard lub
instrument finansowy. Zanim mainnet przyjmie pierwszą stawkę:

- [ ] Konsultacja z prawnikiem od gamingu/krypto (Polska + UE: to może
      podpadać pod ustawę hazardową / MiCA zależnie od konstrukcji).
- [ ] Regulamin + geo-blokada jurysdykcji zabronionych, jeśli prawnik tak wskaże.
- [ ] Jasny komunikat na stronie: ryzyko, pełnoletność, brak gwarancji.

To nie jest porada prawna; to punkt na checkliście, którego pominięcie
kończy się najgorzej ze wszystkich.
