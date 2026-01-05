export enum GamePhase {
    BETTING = 'BETTING',
    ACCUMULATION = 'DELTA_PHASE',
    DROPPING = 'DROPPING',
    PAYOUT = 'PAYOUT',
    PAUSED = 'PAUSED'
}

export interface StockState {
    symbol: string;
    name?: string;
    startPrice?: number;
    currentPrice?: number;
    delta?: number;
    path?: number[];
    slot?: number;
    multiplierIndex?: number;
    multiplier?: number;
}

export interface PlinkoGlobalState {
    phase: GamePhase;
    roundId: string;
    serverTime: number;
    endTime: number;
    stocks: StockState[];
    canUnbet: boolean;
    message?: string;
}