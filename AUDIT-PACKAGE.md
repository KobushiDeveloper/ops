# BattleHoodPrediction: pakiet audytowy

Ten dokument wysyłasz audytorom razem z `contracts/BattleHoodPrediction.sol`.
Sekcje 1-5 to gotowy "audit scope"; sekcja 6 to Twoja samokontrola przed
wysyłką; sekcja 7 to proces wyboru audytora.

## 1. Zakres

- 1 plik: `contracts/BattleHoodPrediction.sol` (~430 linii, solc 0.8.24,
  optimizer 200 runs, zero zależności zewnętrznych poza interfejsem oracle).
- Wzorzec: fork logiki PancakeSwap Prediction V2 (parimutuel UP/DOWN,
  rundy interwałowe) z fee 5% (500 bps, hard cap 10%).
- Deployment: po jednej instancji na asset, na Robinhood Chain (Arbitrum
  Orbit L2, natywna waluta ETH).
- Oracle: Chainlink AggregatorV3Interface (latestRoundData).

## 2. Role i uprawnienia

| Rola | Może | Nie może |
|---|---|---|
| admin | setPaused, setTreasuryFee (<=10%), setOperator, setAdmin, claimTreasury | ruszać puli rund, wypłacać środków graczy |
| operator | genesisStartRound/genesisLockRound/executeRound | nic poza kręceniem rund |
| gracz | betBull/betBear (1 pozycja na rundę), claim | zmieniać/anulować zakładu |

## 3. Inwarianty (audytor ma potwierdzić, że zachodzą ZAWSZE)

1. Suma wypłat rundy <= totalAmount rundy (95% + fee = 100%; zaokrąglenia
   w dół, pył zostaje na kontrakcie).
2. Gracz nie może obstawić po lockTimestamp ani dwa razy w jednej rundzie.
3. claim wypłaca tylko: (a) zwycięzcom zamkniętej rundy z oracleCalled,
   (b) refund gdy runda nie zamknęła się w buforze; nigdy obu naraz;
   nigdy dwa razy (claimed flag).
4. treasuryAmount rośnie wyłącznie o fee wyliczone w _calculateRewards;
   claimTreasury zeruje i wypłaca wyłącznie na adres admina.
5. Draw (closePrice == lockPrice) => cała pula do skarbca, nikt nie jest
   claimable (świadoma decyzja projektowa, jak w PancakeSwap; strona
   komunikuje inaczej w becie: beta refunduje, mainnet wg kontraktu.
   AUDYTOR: oceń ryzyko reputacyjne rozjazdu i zaproponuj wariant refund).
6. executeRound wykonalne tylko w oknie [lockTimestamp, lockTimestamp+buffer];
   po przekroczeniu buffera rundy w locie stają się refundable.
7. Oracle: roundId musi rosnąć, timestamp nie starszy niż allowance;
   brak możliwości podstawienia stale ceny.

## 4. Znane decyzje projektowe (nie zgłaszać jako bug)

- `notContract` (extcodesize + tx.origin): świadome odcięcie botów
  kontraktowych, znane ograniczenia akceptowane.
- Draw = house win (patrz inwariant 5, do dyskusji z audytorem).
- Brak withdraw dla admina poza claimTreasury: celowe.
- Pauza nie blokuje claim: celowe (gracze zawsze wyjmą swoje).

## 5. Pytania, na które audyt MA odpowiedzieć

1. Czy da się wyprowadzić środki graczy inaczej niż przez claim?
2. Czy manipulacja czasem bloku / kolejnością tx (MEV, front-running
   zakładów tuż przed lockiem) daje przewagę ekonomiczną?
3. Czy stale/opóźnione dane oracle mogą rozstrzygnąć rundę błędnie?
4. Reentrancy na claim/claimTreasury (mimo nonReentrant)?
5. Zaokrąglenia: czy pył kumuluje się bezpiecznie, czy da się go ukraść?
6. Co się dzieje przy migracji/awarii oracle (feed deprecated)?
7. DoS: czy ktoś może zablokować executeRound lub claim innym graczom?

## 6. Samokontrola przed wysyłką (zrób sam, za darmo)

```bash
pip install slither-analyzer solc-select
solc-select install 0.8.24 && solc-select use 0.8.24
slither contracts/BattleHoodPrediction.sol
```

- [ ] Slither: zero HIGH; każde MEDIUM opisane (dlaczego akceptujesz).
- [ ] Kompilacja bez warningów.
- [ ] Ręcznie przelicz wypłaty dla rundy 0.8/0.2 ETH (mnożnik x1.727 dla UP
      przy 1.9 netto / 1.1 puli... uwaga: to przykład ze strony; na
      kontrakcie policz na wei).
- [ ] Test genesis + 3 rundy na lokalnym forku (anvil/hardhat) lub testnecie.

## 7. Wybór audytora

Opcje od najtańszej:

1. **Solo-audytor z portfolio** (np. z rankingu Code4rena/Sherlock):
   2-6 tys. USD, 3-7 dni. Dobre dla forka znanego wzorca.
2. **Konkurs audytowy** (Code4rena / Sherlock / Cantina): pula nagród
   od ~10 tys. USD, wiele oczu, dłużej (2-4 tyg.).
3. **Firma butikowa** (np. mniejsze zespoły z referencjami DeFi):
   8-20 tys. USD, raport formalny, re-audyt poprawek w cenie.

Jak weryfikować: publiczne raporty z nazwiskami, znaleziska HIGH w
przeszłości (nie tylko "informational"), reputacja na X/GitHub.

Po audycie:
- [ ] Wszystkie HIGH/CRITICAL naprawione, poprawki re-audytowane.
- [ ] Raport opublikowany, link w stopce strony i w docs.
- [ ] Bug bounty po launchu: nawet skromne (np. 10% skarbca, cap 5 ETH)
      ustawia zachęty po właściwej stronie. Ogłoszenie na stronie + adres
      kontaktowy security.
