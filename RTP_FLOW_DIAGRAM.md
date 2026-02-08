# RTP System Flow Diagram

## Game Flow with RTP Integration

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BETTING PHASE (20s)                          │
│                                                                       │
│  Player places bet on stocks                                         │
│         │                                                             │
│         ├─> PlinkoBetService.placeBet()                             │
│         │   ├─> Deduct from wallet                                  │
│         │   ├─> Store bet in Redis                                  │
│         │   └─> RTPTrackerService.recordBet(market, amount) ◄────┐  │
│         │                                                          │  │
│         │                                                          │  │
└─────────┼──────────────────────────────────────────────────────────┼──┘
          │                                                          │
          │                                                          │
┌─────────┼──────────────────────────────────────────────────────────┼──┐
│         │           ACCUMULATION PHASE (10s)                       │  │
│         │                                                          │  │
│  Capture START prices for all 10 stocks                           │  │
│  Market data updates continuously                                 │  │
│                                                                    │  │
└────────────────────────────────────────────────────────────────────┼──┘
                                                                     │
                                                                     │
┌────────────────────────────────────────────────────────────────────┼──┐
│                    DROPPING PHASE (10s)                            │  │
│                                                                    │  │
│  1. Capture END prices                                            │  │
│  2. Calculate deltas for each stock                               │  │
│         │                                                          │  │
│         ├─> PlinkoEngineService.calculateRoundResults()           │  │
│         │   │                                                      │  │
│         │   ├─> For each stock: calculate delta %                 │  │
│         │   │                                                      │  │
│         │   └─> RTPDecisionService.determineMultiplierIndices()   │  │
│         │       │                                                  │  │
│         │       ├─> Get RTP metrics from Redis ◄──────────────────┘  │
│         │       │   (totalBet, totalWon, playCount, currentRTP)       │
│         │       │                                                     │
│         │       ├─> Check if playCount >= threshold (1000)           │
│         │       │                                                     │
│         │       └─> For each stock:                                  │
│         │           │                                                 │
│         │           ├─ If delta < 0 (RED):                           │
│         │           │   └─> Always choose index 3 or 5 (0x)          │
│         │           │                                                 │
│         │           ├─ If delta = 0 (YELLOW):                        │
│         │           │   ├─ If RTP too low:                           │
│         │           │   │   └─> Choose index 2 or 6 (1.4x, 1.2x)    │
│         │           │   ├─ If RTP too high:                          │
│         │           │   │   └─> Choose index 4 (0.5x)               │
│         │           │   └─ Else: Random from [2, 4, 6]              │
│         │           │                                                 │
│         │           └─ If delta > 0 (GREEN):                         │
│         │               ├─ If RTP too low:                           │
│         │               │   └─> Choose index 0 or 8 (4x, 5x)        │
│         │               ├─ If RTP too high:                          │
│         │               │   └─> Choose index 1 or 7 (2x, 1.5x)      │
│         │               └─ Else: Random from [0, 1, 7, 8]           │
│         │                                                             │
│         └─> Return PlinkoResult[] with chosen indices                │
│                                                                       │
│  3. Broadcast results to clients                                     │
│  4. Animate balls dropping to chosen slots                           │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
                          │
                          │
┌─────────────────────────┼─────────────────────────────────────────────┐
│                         │      PAYOUT PHASE (5s)                      │
│                         │                                             │
│                         ├─> PlinkoPayoutService.processRoundPayouts()│
│                         │   │                                         │
│                         │   ├─> For each player:                     │
│                         │   │   ├─> Calculate winnings based on      │
│                         │   │   │   chosen multiplier indices         │
│                         │   │   ├─> Credit wallet                    │
│                         │   │   └─> Emit payout event to client      │
│                         │   │                                         │
│                         │   ├─> Track round totals:                  │
│                         │   │   ├─ roundTotalBet                     │
│                         │   │   └─ roundTotalWon                     │
│                         │   │                                         │
│                         │   └─> RTPTrackerService.recordWin()        │
│                         │       (market, roundTotalWon)              │
│                         │                                             │
│                         └─> Update Redis: plinko:rtp:{market}        │
│                             ├─ totalWon += roundTotalWon             │
│                             └─ (totalBet already updated in betting) │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
                          │
                          │
                          └─────> LOOP BACK TO BETTING PHASE
```

## Redis Data Structure

```
Key: plinko:rtp:CryptoStream
Type: Hash
Fields:
  ├─ totalBet: 152300.50    (Sum of all bets)
  ├─ totalWon: 147025.25    (Sum of all payouts)
  └─ playCount: 1523        (Number of bets placed)

Calculated:
  └─ currentRTP = (147025.25 / 152300.50) * 100 = 96.54%
```

## Multiplier Index Mapping

```
Index:  0    1    2    3    4    5    6    7    8
Value:  4x   2x  1.4x  0x  0.5x  0x  1.2x 1.5x  5x
        │    │    │    │    │    │    │    │    │
        └────┴────┼────┼────┼────┼────┼────┴────┘
             │    │    │    │    │    │    │
        GREEN│YELLOW│ RED │YELLOW│ RED │YELLOW│GREEN
             │    │    │    │    │    │    │
        High │ Med │ Loss│ Low │ Loss│ Med │ High
        Win  │ Win │     │ Win │     │ Win │ Win
```

## Decision Matrix

```
┌──────────────┬────────────────┬─────────────────┬──────────────────┐
│ Stock Delta  │ Color          │ RTP Status      │ Chosen Indices   │
├──────────────┼────────────────┼─────────────────┼──────────────────┤
│ delta < 0    │ RED            │ Any             │ 3 or 5 (0x)      │
├──────────────┼────────────────┼─────────────────┼──────────────────┤
│ delta = 0    │ YELLOW         │ RTP too low     │ 2 or 6 (1.4x/1.2x)│
│              │                │ RTP too high    │ 4 (0.5x)         │
│              │                │ RTP balanced    │ Random [2,4,6]   │
├──────────────┼────────────────┼─────────────────┼──────────────────┤
│ delta > 0    │ GREEN          │ RTP too low     │ 0 or 8 (4x/5x)   │
│              │                │ RTP too high    │ 1 or 7 (2x/1.5x) │
│              │                │ RTP balanced    │ Random [0,1,7,8] │
└──────────────┴────────────────┴─────────────────┴──────────────────┘

Note: "RTP balanced" includes cases where playCount < threshold (1000)
```

## Example Round

```
Market: CryptoStream
Round ID: abc-123-def
Current RTP: 94.2% (below desired 96.5%)
Play Count: 1250 (above threshold)

Stock Results:
┌────────┬─────────┬────────┬───────┬────────────┬────────────┬──────────┐
│ Stock  │ Start   │ End    │ Delta │ Color      │ Index      │ Multi    │
├────────┼─────────┼────────┼───────┼────────────┼────────────┼──────────┤
│ AAPL   │ 150.00  │ 150.45 │ +0.30%│ GREEN      │ 8          │ 5x       │
│        │         │        │       │ (RTP low)  │ (choose    │          │
│        │         │        │       │            │  high)     │          │
├────────┼─────────┼────────┼───────┼────────────┼────────────┼──────────┤
│ TSLA   │ 200.00  │ 199.80 │ -0.10%│ RED        │ 3          │ 0x       │
│        │         │        │       │ (always 0) │            │          │
├────────┼─────────┼────────┼───────┼────────────┼────────────┼──────────┤
│ BTC    │ 45000   │ 45000  │  0.00%│ YELLOW     │ 2          │ 1.4x     │
│        │         │        │       │ (RTP low)  │ (choose    │          │
│        │         │        │       │            │  high)     │          │
└────────┴─────────┴────────┴───────┴────────────┴────────────┴──────────┘

Player Bet: $100 split across [AAPL, TSLA, BTC]
  ├─ AAPL: $33.33 × 5x = $166.65
  ├─ TSLA: $33.33 × 0x = $0.00
  └─ BTC:  $33.34 × 1.4x = $46.68
  
Total Payout: $213.33
Player Profit: $113.33
Round RTP: 213.33%

Updated Metrics:
  ├─ totalBet: 152300.50 + 100 = 152400.50
  ├─ totalWon: 147025.25 + 213.33 = 147238.58
  ├─ playCount: 1523 + 1 = 1524
  └─ currentRTP: (147238.58 / 152400.50) × 100 = 96.61%
```
