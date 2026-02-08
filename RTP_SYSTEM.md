# RTP (Return to Player) System Documentation

## Overview

The RTP system dynamically adjusts game outcomes to converge toward a target RTP percentage while maintaining the market-driven nature of the stock-based Plinko game.

## How It Works

### 1. **Stock Delta Classification**

After the accumulation phase (10 seconds), each stock's price delta is calculated and classified:

- **RED (Delta < 0)**: Stock price decreased
- **YELLOW (Delta = 0)**: Stock price unchanged
- **GREEN (Delta > 0)**: Stock price increased

### 2. **Multiplier Mapping**

The multiplier array `[4, 2, 1.4, 0, 0.5, 0, 1.2, 1.5, 5]` is divided into three zones:

| Zone   | Indices | Multipliers        | Purpose                    |
|--------|---------|-------------------|----------------------------|
| RED    | 3, 5    | 0x, 0x            | Losing slots (delta < 0)   |
| YELLOW | 2, 4, 6 | 1.4x, 0.5x, 1.2x  | Neutral slots (delta = 0)  |
| GREEN  | 0, 1, 7, 8 | 4x, 2x, 1.5x, 5x | Winning slots (delta > 0)  |

### 3. **RTP-Based Selection Logic**

The system tracks:
- **Total Bets**: Sum of all wagers across all rounds
- **Total Wins**: Sum of all payouts across all rounds
- **Play Count**: Number of bets placed
- **Current RTP**: `(Total Wins / Total Bets) × 100`

**Decision Logic:**

#### For RED Stocks (Delta < 0):
- **Always** land on indices 3 or 5 (both 0x multipliers)
- No RTP adjustment needed - these are guaranteed losses

#### For YELLOW Stocks (Delta = 0):
- **If Current RTP < Desired RTP** (need to increase RTP):
  - Choose higher multipliers: 1.4x (index 2) or 1.2x (index 6)
- **If Current RTP > Desired RTP** (need to decrease RTP):
  - Choose lower multiplier: 0.5x (index 4)
- **If RTP is balanced or insufficient data**:
  - Randomly choose from all yellow slots (2, 4, 6)

#### For GREEN Stocks (Delta > 0):
- **If Current RTP < Desired RTP** (need to increase RTP):
  - Choose higher multipliers: 4x (index 0) or 5x (index 8)
- **If Current RTP > Desired RTP** (need to decrease RTP):
  - Choose lower multipliers: 2x (index 1) or 1.5x (index 7)
- **If RTP is balanced or insufficient data**:
  - Randomly choose from all green slots (0, 1, 7, 8)

### 4. **Threshold Mechanism**

The system only starts making RTP-based adjustments after reaching the **threshold play count** (default: 1000 bets).

Before the threshold:
- Random selection within each color zone
- Allows natural variance
- Prevents premature corrections based on small sample sizes

## Configuration

### Environment Variables

```env
DESIRED_RTP=96.5              # Target RTP percentage (96.5%)
THRESHOLD_PLAYCOUNT=1000      # Minimum bets before RTP adjustments kick in
PLINKO_MULTIPLIERS="4,2,1.4,0,0.5,0,1.2,1.5,5"  # Multiplier array
PLINKO_STOCK_COUNT=10         # Number of stocks per round
```

## Architecture

### Services

1. **RTPTrackerService** (`rtp-tracker.service.ts`)
   - Stores RTP metrics in Redis
   - Tracks: `totalBet`, `totalWon`, `playCount`
   - Provides current RTP calculation
   - Methods:
     - `recordBet(market, amount)` - Called when bet is placed
     - `recordWin(market, amount)` - Called after payout
     - `getRTPMetrics(market)` - Returns current RTP stats
     - `hasEnoughData(metrics)` - Checks if threshold is met

2. **RTPDecisionService** (`rtp-decision.service.ts`)
   - Makes multiplier index decisions
   - Implements the RED/YELLOW/GREEN logic
   - Methods:
     - `determineMultiplierIndices(market, stockDeltas)` - Main decision function
     - Returns array of `RTPDecision` objects with chosen indices

3. **PlinkoEngineService** (modified)
   - Now async and RTP-aware
   - Calls `RTPDecisionService` instead of using sensitivity mapping
   - Returns `PlinkoResult[]` with RTP-determined indices

4. **PlinkoBetService** (modified)
   - Records bets via `rtpTracker.recordBet()`

5. **PlinkoPayoutService** (modified)
   - Records wins via `rtpTracker.recordWin()`
   - Logs round-level RTP for monitoring

## Data Flow

```
1. BETTING PHASE
   └─> User places bet
       └─> PlinkoBetService.placeBet()
           └─> rtpTracker.recordBet(market, amount)

2. ACCUMULATION PHASE
   └─> Start prices captured

3. DROPPING PHASE
   └─> End prices captured
   └─> Calculate deltas for all stocks
   └─> PlinkoEngineService.calculateRoundResults()
       └─> rtpDecisionService.determineMultiplierIndices()
           ├─> getRTPMetrics(market)
           ├─> For each stock:
           │   ├─> If delta < 0: Choose index 3 or 5
           │   ├─> If delta = 0: Choose based on RTP
           │   └─> If delta > 0: Choose based on RTP
           └─> Return RTPDecision[] with indices

4. PAYOUT PHASE
   └─> Calculate winnings based on chosen indices
   └─> PlinkoPayoutService.processRoundPayouts()
       └─> rtpTracker.recordWin(market, totalWon)
```

## Redis Keys

```
plinko:rtp:{market}
  ├─ totalBet: float
  ├─ totalWon: float
  └─ playCount: integer
```

## Monitoring & Logging

The system provides detailed logging:

```
[RTP CryptoStream] Current: 95.23% | Desired: 96.5% | Deviation: -1.27% | Plays: 1523 | Bet: 15230.00 | Won: 14505.00
[RTP Decisions] Market: CryptoStream | Round: abc-123
  AAPL: Delta=0.150 → Index=8 (5x) | GREEN (delta > 0) + Low RTP → Choose 4x or 5x
  TSLA: Delta=-0.050 → Index=3 (0x) | RED (delta < 0) → Always land on 0x multiplier
  BTC: Delta=0.000 → Index=2 (1.4x) | YELLOW (delta = 0) + Low RTP → Choose 1.4x or 1.2x
[RTP Tracking] Round abc-123 | Bet: 500.00 | Won: 485.00 | RTP: 97.00%
```

## Example Scenarios

### Scenario 1: RTP Too Low (Need to Increase)
```
Current RTP: 94.5% | Desired: 96.5%
Play Count: 1200 (above threshold)

Stock Results:
- AAPL: Delta = +0.25% (GREEN) → Choose index 0 (4x) or 8 (5x) ✓
- TSLA: Delta = -0.10% (RED) → Choose index 3 (0x) or 5 (0x)
- BTC: Delta = 0.00% (YELLOW) → Choose index 2 (1.4x) or 6 (1.2x) ✓
```

### Scenario 2: RTP Too High (Need to Decrease)
```
Current RTP: 98.2% | Desired: 96.5%
Play Count: 1500 (above threshold)

Stock Results:
- AAPL: Delta = +0.30% (GREEN) → Choose index 1 (2x) or 7 (1.5x) ✓
- TSLA: Delta = -0.15% (RED) → Choose index 3 (0x) or 5 (0x)
- BTC: Delta = 0.00% (YELLOW) → Choose index 4 (0.5x) ✓
```

### Scenario 3: Below Threshold (Random)
```
Current RTP: 102.5% | Desired: 96.5%
Play Count: 500 (below threshold)

Stock Results:
- AAPL: Delta = +0.20% (GREEN) → Random from [0, 1, 7, 8]
- TSLA: Delta = -0.08% (RED) → Choose index 3 or 5
- BTC: Delta = 0.00% (YELLOW) → Random from [2, 4, 6]
```

## Advantages of This Approach

1. **Maintains Market Authenticity**: Outcomes still tied to real stock movements
2. **Subtle Control**: Players see natural-looking results based on deltas
3. **Gradual Convergence**: RTP adjusts over time, not per-round
4. **Transparent Logic**: Clear mapping between delta colors and multiplier zones
5. **Auditable**: All decisions logged with reasoning

## Testing & Validation

To test the RTP system:

1. **Check Redis Metrics**:
   ```bash
   redis-cli HGETALL plinko:rtp:CryptoStream
   ```

2. **Monitor Logs**: Look for `[RTP]` prefixed messages

3. **Simulate Load**: Place many bets and verify RTP converges to target

4. **Reset Metrics** (if needed):
   ```typescript
   await rtpTrackerService.resetRTPMetrics('CryptoStream');
   ```

## Future Enhancements

- Per-player RTP tracking
- Time-windowed RTP (hourly/daily reset)
- Admin dashboard for RTP monitoring
- Configurable RTP tolerance bands
- A/B testing different RTP targets
