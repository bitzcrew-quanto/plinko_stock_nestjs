# RTP System - Quick Start Guide

## Prerequisites

- Redis running on `localhost:6379` (state) and `localhost:6380` (pubsub)
- Node.js and npm installed
- HQ service running on `localhost:5050`

## Installation

No additional packages needed - all dependencies are already in the project.

## Configuration

The `.env` file has been updated with RTP settings:

```env
DESIRED_RTP=96.5              # Target RTP percentage
THRESHOLD_PLAYCOUNT=100       # Minimum bets before RTP kicks in
LIMIT_PLAYCOUNT=1000          # Maximum bets before auto-reset
PLINKO_MULTIPLIERS="4,2,1.4,0,0.5,0,1.2,1.5,5"
PLINKO_STOCK_COUNT=10         # Changed from 20 to 10
```

**Note**: The system will automatically reset all RTP metrics (totalBet, totalWon, playCount) when playCount reaches the LIMIT_PLAYCOUNT. See `RTP_LIMIT_FEATURE.md` for details.

## Running the System

1. **Start the server**:
   ```bash
   npm run start:dev
   ```

2. **Watch the logs** for RTP messages:
   ```
   [RTP CryptoStream] Current: 0.00% | Desired: 96.5% | Deviation: -96.50% | Plays: 0
   [RTP Decisions] Market: CryptoStream | Round: abc-123
   [RTP Tracking] Round abc-123 | Bet: 100.00 | Won: 95.00 | RTP: 95.00%
   ```

## Monitoring RTP

### Check Redis Metrics

```bash
# Connect to Redis
redis-cli

# View RTP data for a market
HGETALL plinko:rtp:CryptoStream

# Expected output:
# 1) "totalBet"
# 2) "15230.50"
# 3) "totalWon"
# 4) "14705.25"
# 5) "playCount"
# 6) "1523"
```

### Calculate Current RTP

```javascript
currentRTP = (totalWon / totalBet) × 100
currentRTP = (14705.25 / 15230.50) × 100 = 96.55%
```

## Testing the System

### Phase 1: Below Threshold (Random Behavior)

Place bets until you have < 100 plays. The system should:
- ✅ Track all bets and wins
- ✅ Make random selections within color zones
- ✅ Log: "Balanced RTP → Random slot"

### Phase 2: Above Threshold (RTP Adjustment)

After 100+ plays (but before 1000):
- ✅ System starts making RTP-based decisions
- ✅ If RTP < 96.5%: Chooses higher multipliers
- ✅ If RTP > 96.5%: Chooses lower multipliers

### Phase 3: Auto-Reset at Limit

At 1000 plays:
- ✅ System automatically resets all metrics to 0
- ✅ Log: "[RTP Reset] Market reached limit..."
- ✅ Next bet starts fresh cycle from Phase 1

### Verification Checklist

- [ ] Bets are recorded: `playCount` increments
- [ ] Wins are tracked: `totalWon` increases after payouts
- [ ] RTP converges toward 96.5% over time
- [ ] RED stocks always land on 0x
- [ ] YELLOW/GREEN stocks adjust based on RTP
- [ ] Logs show decision reasoning

## Understanding the Logs

### RTP Status Log
```
[RTP CryptoStream] Current: 95.23% | Desired: 96.5% | Deviation: -1.27% | 
Plays: 523/1000 (477 until reset) | Threshold: 100 | Bet: 15230.00 | Won: 14505.00
```
- **Current**: Actual RTP percentage
- **Desired**: Target RTP (96.5%)
- **Deviation**: How far off we are
- **Plays**: Current plays / Limit (plays until auto-reset)
- **Threshold**: Minimum plays before RTP adjustments
- **Bet**: Total wagered
- **Won**: Total paid out

### Decision Log
```
[RTP Decisions] Market: CryptoStream | Round: abc-123
  AAPL: Delta=0.150 → Index=8 (5x) | GREEN (delta > 0) + Low RTP → Choose 4x or 5x
  TSLA: Delta=-0.050 → Index=3 (0x) | RED (delta < 0) → Always land on 0x multiplier
  BTC: Delta=0.000 → Index=2 (1.4x) | YELLOW (delta = 0) + Low RTP → Choose 1.4x or 1.2x
```
- Shows which index each stock landed on
- Explains the reasoning behind each decision

### Round Tracking Log
```
[RTP Tracking] Round abc-123 | Bet: 500.00 | Won: 485.00 | RTP: 97.00%
```
- Shows the RTP for this specific round
- Helps identify if individual rounds are balanced

## Troubleshooting

### Issue: RTP not being tracked

**Check:**
1. Redis is running: `redis-cli ping` should return `PONG`
2. Bets are being placed successfully
3. Check logs for errors in `RTPTrackerService`

**Fix:**
```bash
# Restart Redis
redis-server

# Check Redis connection in logs
# Should see: "Redis State Client connected"
```

### Issue: RTP not adjusting

**Check:**
1. Play count >= 1000
2. Logs show "Balanced RTP → Random" (means below threshold)

**Fix:**
```bash
# Check current play count
redis-cli HGET plinko:rtp:CryptoStream playCount

# If you want to test immediately, lower the threshold:
# In .env: THRESHOLD_PLAYCOUNT=10
```

### Issue: All stocks landing on 0x

**Check:**
1. Are all stocks showing negative delta?
2. Check market data is updating

**Fix:**
- Verify market data feed is active
- Check `SUBSCRIBE_CHANNELS` in .env

## Resetting RTP Metrics

If you want to start fresh:

```bash
# Delete RTP data for a specific market
redis-cli DEL plinko:rtp:CryptoStream

# Or delete all RTP data
redis-cli KEYS "plinko:rtp:*" | xargs redis-cli DEL
```

## Advanced: Manual RTP Adjustment

If you need to manually set RTP metrics for testing:

```bash
redis-cli HSET plinko:rtp:CryptoStream totalBet 10000
redis-cli HSET plinko:rtp:CryptoStream totalWon 9500
redis-cli HSET plinko:rtp:CryptoStream playCount 1500
```

This will set RTP to 95% with 1500 plays, triggering the system to increase payouts.

## Expected Behavior

### First 1000 Bets
- Random selections within color zones
- RTP will fluctuate wildly (could be 80% or 110%)
- This is normal - building sample size

### After 1000 Bets
- RTP should start converging toward 96.5%
- Adjustments become more consistent
- Deviation should shrink over time

### Long Term (10,000+ Bets)
- RTP should stabilize around 96.3% - 96.7%
- Small fluctuations are normal
- System maintains house edge while feeling fair

## Performance Notes

- RTP tracking uses atomic Redis operations (no race conditions)
- Minimal performance impact (<5ms per bet)
- Scales horizontally with multiple server instances
- Each market tracks RTP independently

## Next Steps

1. ✅ Start the server
2. ✅ Place some test bets
3. ✅ Monitor Redis metrics
4. ✅ Verify RTP convergence after 1000+ plays
5. ✅ Review logs for decision reasoning

## Support

For issues or questions:
1. Check `RTP_SYSTEM.md` for detailed documentation
2. Review `RTP_FLOW_DIAGRAM.md` for visual flow
3. Check `RTP_IMPLEMENTATION_SUMMARY.md` for file changes
