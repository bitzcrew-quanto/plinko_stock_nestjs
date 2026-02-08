# RTP Limit & Auto-Reset Feature

## Overview

The RTP system now includes an automatic reset mechanism that clears all RTP metrics (totalBet, totalWon, playCount) when the play count reaches a configurable limit. This prevents indefinite accumulation and allows for fresh RTP cycles.

## Configuration

### Environment Variables

```env
THRESHOLD_PLAYCOUNT=100    # Minimum plays before RTP adjustments start
LIMIT_PLAYCOUNT=1000       # Maximum plays before auto-reset
```

### How It Works

```
Play Count Timeline:
0 ────────► 100 ────────────────────► 1000 ────► 0 (RESET)
│           │                          │
│           │                          │
Random      RTP Adjustments Start      Auto-Reset Triggered
Selection   (based on current RTP)     (all metrics cleared)
```

## Behavior

### Phase 1: Below Threshold (0-99 plays)
- **RTP Tracking**: ✅ Bets and wins are recorded
- **RTP Adjustments**: ❌ Random selection within color zones
- **Status**: Building sample size

### Phase 2: Active RTP Control (100-999 plays)
- **RTP Tracking**: ✅ Bets and wins are recorded
- **RTP Adjustments**: ✅ Intelligent multiplier selection
- **Status**: Converging toward desired RTP (96.5%)

### Phase 3: Auto-Reset (1000 plays reached)
- **Trigger**: When playCount >= LIMIT_PLAYCOUNT
- **Action**: All Redis metrics reset to 0
  - `totalBet` → 0
  - `totalWon` → 0
  - `playCount` → 0
- **Next Bet**: Starts fresh cycle from Phase 1
- **Log Message**: `[RTP Reset] Market CryptoStream reached limit of 1000 plays. Resetting RTP metrics to start fresh cycle.`

## Example Scenario

```
Configuration:
- THRESHOLD_PLAYCOUNT = 100
- LIMIT_PLAYCOUNT = 1000
- DESIRED_RTP = 96.5%

Timeline:
┌─────────────────────────────────────────────────────────────────┐
│ Play #1-99: Random selections, RTP = 102.3% (high variance)    │
│ Status: "Plays: 99/1000 (901 until reset) | Threshold: 100"    │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│ Play #100: RTP adjustments activate                             │
│ Status: "Plays: 100/1000 (900 until reset) | Threshold: 100"   │
│ Current RTP: 102.3% → System starts choosing lower multipliers │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│ Play #500: RTP converging                                       │
│ Status: "Plays: 500/1000 (500 until reset) | Threshold: 100"   │
│ Current RTP: 97.1% → System fine-tuning selections             │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│ Play #999: Near limit                                           │
│ Status: "Plays: 999/1000 (1 until reset) | Threshold: 100"     │
│ Current RTP: 96.4% → Close to target                           │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│ Play #1000: LIMIT REACHED - AUTO RESET                          │
│ Log: "[RTP Reset] Market CryptoStream reached limit of 1000    │
│       plays. Resetting RTP metrics to start fresh cycle."      │
│                                                                  │
│ Before Reset:                                                   │
│   totalBet: 50,000                                              │
│   totalWon: 48,200                                              │
│   playCount: 1000                                               │
│   currentRTP: 96.4%                                             │
│                                                                  │
│ After Reset:                                                    │
│   totalBet: 0                                                   │
│   totalWon: 0                                                   │
│   playCount: 0                                                  │
│   currentRTP: 0%                                                │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│ Play #1 (new cycle): Fresh start                                │
│ Status: "Plays: 1/1000 (999 until reset) | Threshold: 100"     │
│ Back to random selections until threshold reached               │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Details

### When Reset Happens

The reset check occurs in `RTPTrackerService.recordBet()`:

```typescript
// Before recording each bet:
1. Check current playCount
2. If playCount >= LIMIT_PLAYCOUNT:
   a. Log reset message
   b. Delete Redis key (clears all metrics)
3. Record the new bet (starts at playCount = 1)
```

### Redis Operations

```bash
# Before reset (at play #1000)
redis-cli HGETALL plinko:rtp:CryptoStream
# Returns:
# totalBet: 50000
# totalWon: 48200
# playCount: 1000

# After reset (automatic)
redis-cli HGETALL plinko:rtp:CryptoStream
# Returns: (empty) or new values starting from 0
```

## Monitoring

### Log Messages

**Normal Operation:**
```
[RTP CryptoStream] Current: 96.45% | Desired: 96.5% | Deviation: -0.05% | 
Plays: 523/1000 (477 until reset) | Threshold: 100 | Bet: 26150.00 | Won: 25215.00
```

**Approaching Limit:**
```
[RTP CryptoStream] Current: 96.52% | Desired: 96.5% | Deviation: +0.02% | 
Plays: 995/1000 (5 until reset) | Threshold: 100 | Bet: 49750.00 | Won: 48013.00
```

**Reset Triggered:**
```
[RTP Reset] Market CryptoStream reached limit of 1000 plays. 
Resetting RTP metrics to start fresh cycle.
```

**After Reset:**
```
[RTP CryptoStream] Current: 0.00% | Desired: 96.5% | Deviation: -96.50% | 
Plays: 1/1000 (999 until reset) | Threshold: 100 | Bet: 50.00 | Won: 0.00
```

## Benefits

### 1. **Prevents Infinite Accumulation**
- Metrics don't grow indefinitely
- Keeps Redis memory usage bounded
- Fresh cycles prevent stale data

### 2. **Regular RTP Validation**
- Each cycle validates RTP convergence
- Easier to detect if RTP logic is working
- Can compare RTP across multiple cycles

### 3. **Configurable Cycles**
- Adjust limit based on your needs
- Shorter cycles (500) = more frequent resets
- Longer cycles (5000) = more stable long-term RTP

### 4. **Transparent Operation**
- All resets are logged
- Players don't notice (seamless)
- Admins can track reset frequency

## Configuration Recommendations

### For Testing
```env
THRESHOLD_PLAYCOUNT=10     # Quick RTP activation
LIMIT_PLAYCOUNT=100        # Frequent resets for testing
```

### For Development
```env
THRESHOLD_PLAYCOUNT=50     # Moderate threshold
LIMIT_PLAYCOUNT=500        # Regular resets
```

### For Production
```env
THRESHOLD_PLAYCOUNT=100    # Stable threshold
LIMIT_PLAYCOUNT=1000       # Balanced cycle length
```

### For High Volume
```env
THRESHOLD_PLAYCOUNT=500    # Larger sample before adjusting
LIMIT_PLAYCOUNT=10000      # Long cycles for stability
```

## Important Notes

1. **Reset is Automatic**: No manual intervention needed
2. **Per-Market**: Each market has independent limits and resets
3. **Seamless**: Players experience no interruption
4. **Logged**: All resets are recorded in logs for auditing
5. **Configurable**: Adjust thresholds without code changes

## Troubleshooting

### Issue: RTP keeps resetting too frequently

**Cause**: LIMIT_PLAYCOUNT is too low

**Fix**:
```env
# Increase the limit
LIMIT_PLAYCOUNT=5000
```

### Issue: RTP never resets

**Cause**: Not enough plays to reach limit

**Check**:
```bash
redis-cli HGET plinko:rtp:CryptoStream playCount
```

**Fix**: Wait for more plays or lower the limit for testing

### Issue: Want to manually trigger reset

**Solution**:
```bash
# Delete the RTP key
redis-cli DEL plinko:rtp:CryptoStream
```

## Monitoring Dashboard Ideas

Track across multiple cycles:

```
Cycle #1: 1000 plays, Final RTP: 96.4%
Cycle #2: 1000 plays, Final RTP: 96.6%
Cycle #3: 1000 plays, Final RTP: 96.5%
Average: 96.5% ✓

Conclusion: RTP system working correctly
```
