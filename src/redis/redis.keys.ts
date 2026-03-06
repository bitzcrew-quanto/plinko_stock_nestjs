export const getKeyForPlayerSession = (sessionToken: string): string => {
    return `session:${sessionToken}`;
};

// --- Market Data Keys ---
/**
 * Key for storing the latest enriched market snapshot per market/room.
 */
export const getKeyForLastMarketSnapshot = (market: string): string => {
    const safe = market.toLowerCase();
    return `market:last:${safe}`;
};

export const getKeyForGameValidStocks = (gameId: string, market: string): string =>
    `game:${gameId}:valid_stocks:${market}`;

export const getGameRefetchChannel = (gameId: string): string =>
    // `game:${gameId}:refetch_stocks`;
    `game:${gameId}:refetch`;

export const getMarketConfigsKey = (): string => {
    return 'markets';
};

// --- Tenant/Balance Keys ---
export const getTenantUpdatesChannel = (tenantId: string): string => {
    return `tenant:${tenantId}:updates`;
};

/**
 * Stores the current game phase, time left, and active round ID.
 * Structure: JSON { phase: 'BETTING', roundId: '...', timeLeft: 5000 }
 */
export const getPlinkoStateKey = (room: string): string => {
    return `plinko:${room}:state`;
};

/**
 * Stores the list of active stocks selected for the current round.
 */
export const getPlinkoStocksKey = (room: string): string => {
    return `plinko:${room}:stocks`;
};

/**
 * Hash storing all bets for a specific round.
 * Key: userId, Value: JSON { amount, stock, timestamp }
 */
export const getPlinkoRoundBetsKey = (room: string, roundId: string): string => {
    return `plinko:${room}:bets:${roundId}`;
};

/**
 * Key for history verification or audit
 */
export const getPlinkoRoundResultKey = (room: string, roundId: string): string => {
    return `plinko:${room}:result:${roundId}`;
};

// --- Leaderboard & History Keys ---

/**
 * Stores top payouts globally (Score = Payout, Value = JSON of player data)
 */
export const getPlinkoGlobalLeaderboardKey = (): string => `plinko:leaderboard:global`;

/**
 * Stores the last 20 public round results for a specific market (Roadmap)
 */
export const getPlinkoMarketHistoryKey = (market: string): string => `plinko:${market}:history`;

/**
 * Stores a specific player's personal bet history (Last 20 bets)
 */
export const getPlinkoPlayerHistoryKey = (playerId: string): string => {
    return `plinko:history:player:${playerId}`;
};

/**
 * Stores the starting prices of stocks at the beginning of the Accumulation phase.
 */
export const getPlinkoMarketBaselinesKey = (market: string): string => {
    const safe = market.toLowerCase();
    return `plinko:${safe}:baselines`;
};
export const getGameConfigKey = (gamePublicId: string): string => {
    return `game:config:${gamePublicId}`;
}