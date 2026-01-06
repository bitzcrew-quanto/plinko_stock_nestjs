import { io, Socket } from 'socket.io-client';
import { createClient } from 'redis';
import * as ExcelJS from 'exceljs';
import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CONFIGURATION ---
const CONFIG = {
    // Server Details
    WS_URL: 'http://localhost:5002',
    REDIS_URL: process.env.STATE_REDIS_URL || 'redis://localhost:6379',

    // Test Parameters
    MARKET_ROOM: 'CryptoStream',
    NUM_USERS: 50,
    BETS_PER_ROUND: 1,
    TEST_DURATION_MIN: 3,

    // Betting Strategy
    MIN_WAGER: 10,
    MAX_WAGER: 100
};

// --- DATA STRUCTURES ---
interface StockData {
    symbol: string;
    startPrice: number;
    endPrice: number;
    delta: number;
    multiplierIndex: number;
}

interface BetRecord {
    roundId: string;
    userId: string;
    stocks: string[];
    wager: number;
    payout: number;
    result: 'WIN' | 'LOSS' | 'PENDING';
}

interface GameRoundLog {
    roundId: string;
    serverTime: string;
    phase: string;
    stocksAvailable: number;
    totalBetsSent: number;
    totalPayoutReceived: number;
    netHouseProfit: number;
    outcomeMessage: string;
    stockDetails: StockData[]; // NEW: Track stock performance per round
}

interface PlayerStats {
    userId: string;
    totalWager: number;
    totalWon: number;
    roundsPlayed: number;
    wins: number;
    losses: number;
}

// --- GLOBAL STATE ---
const roundLogs = new Map<string, GameRoundLog>();
const playerStats = new Map<string, PlayerStats>();
const allBets: BetRecord[] = []; // NEW: Global registry of all bets
const activeSockets: Socket[] = [];
let isTestRunning = true;
let currentPhase = '';
let currentRoundId = '';

// --- REDIS SETUP ---
const redis = createClient({ url: CONFIG.REDIS_URL });

async function createValidSession(userId: string, token: string) {
    const sessionKey = `session:${token}`;

    const sessionData = {
        sessionToken: token,
        tenantPlayerId: userId,
        tenantPublicId: 'load-test-tenant',
        room: CONFIG.MARKET_ROOM, // Matches Crypto Channel
        currency: 'USD',
        currentBalance: '50000',
        updatedAt: new Date().toISOString()
    };

    await redis.set(sessionKey, JSON.stringify(sessionData), { EX: 86400 });
}

// --- BOT LOGIC ---
async function spawnBot(index: number) {
    const userId = `bot_${index}_${randomUUID().split('-')[0]}`;
    const token = `test_token_${randomUUID()}`;

    // 1. Create Session
    await createValidSession(userId, token);

    // 2. Connect
    const socket = io(CONFIG.WS_URL, {
        auth: { token },
        transports: ['websocket'],
        forceNew: true
    });

    activeSockets.push(socket);
    playerStats.set(userId, {
        userId, totalWager: 0, totalWon: 0, roundsPlayed: 0, wins: 0, losses: 0
    });

    socket.on('connect', () => { /* Connected */ });

    // A. GAME STATE
    socket.on('game:state', (state: any) => {
        handleGameState(socket, userId, state);
    });

    // B. PAYOUT
    socket.on('game:payout', (data: any) => {
        handlePayout(userId, data);
    });

    socket.on('error', (err: any) => {
        // console.error(`[${userId}] Socket Error:`, err);
    });
}

// --- EVENT HANDLERS ---

function handleGameState(socket: Socket, userId: string, state: any) {
    if (state.roundId !== currentRoundId) {
        console.log(`\n>>> NEW CRYPTO ROUND: ${state.roundId}`);
        currentRoundId = state.roundId;

        roundLogs.set(currentRoundId, {
            roundId: currentRoundId,
            serverTime: new Date(state.serverTime).toISOString(),
            phase: state.phase,
            stocksAvailable: state.stocks?.length || 0,
            totalBetsSent: 0,
            totalPayoutReceived: 0,
            netHouseProfit: 0,
            outcomeMessage: '',
            stockDetails: []
        });
    }

    const log = roundLogs.get(currentRoundId);
    if (log) log.phase = state.phase;
    currentPhase = state.phase;

    // 1. BETTING PHASE (Capture Start Prices)
    if (state.phase === 'BETTING' && state.stocks && state.stocks.length > 0) {
        if (log && log.stockDetails.length === 0) {
            log.stockDetails = state.stocks.map((s: any) => ({
                symbol: s.symbol,
                startPrice: s.currentPrice,
                endPrice: 0,
                delta: 0,
                multiplierIndex: -1
            }));
        }

        // 50% chance to bet
        if (Math.random() > 0.5) {
            const stocksList = state.stocks.map((s: any) => s.symbol);
            placeRealBet(socket, userId, stocksList);
        }
    }

    // 2. DROPPING PHASE (Capture End Prices & Results)
    if (state.phase === 'DROPPING') {
        if (log && state.stocks && state.stocks.length > 0) {
            if (!log.stockDetails) log.stockDetails = [];

            // Update stock details with end results
            state.stocks.forEach((s: any) => {
                const existing = log.stockDetails.find(d => d.symbol === s.symbol);
                if (existing) {
                    existing.endPrice = s.currentPrice;
                    existing.delta = s.delta;
                    existing.multiplierIndex = s.multiplierIndex;
                } else {
                    // Fallback if not init in betting (e.g. late join)
                    log.stockDetails.push({
                        symbol: s.symbol,
                        startPrice: 0,
                        endPrice: s.currentPrice,
                        delta: s.delta,
                        multiplierIndex: s.multiplierIndex
                    });
                }
            });

            if (!log.outcomeMessage && state.stocks[0]) {
                const firstStock = state.stocks[0];
                log.outcomeMessage = `Example: ${firstStock.symbol} delta ${firstStock.delta}% -> Index ${firstStock.multiplierIndex}`;
                console.log(`[Real Gameplay] Dropping! ${log.outcomeMessage}`);
            }
        }
    }
}

function placeRealBet(socket: Socket, userId: string, availableStocks: string[]) {
    // Pick 1 to 3 random crypto assets
    const count = Math.floor(Math.random() * 3) + 1;
    const selectedStocks: string[] = [];
    for (let i = 0; i < count; i++) {
        const randomStock = availableStocks[Math.floor(Math.random() * availableStocks.length)];
        selectedStocks.push(randomStock);
    }

    const amount = Math.floor(Math.random() * (CONFIG.MAX_WAGER - CONFIG.MIN_WAGER) + CONFIG.MIN_WAGER);

    socket.emit('place_bet', {
        amount: amount,
        stocks: selectedStocks
    });

    const log = roundLogs.get(currentRoundId);
    if (log) log.totalBetsSent++;

    const stats = playerStats.get(userId);
    if (stats) stats.totalWager += amount;

    // Record the bet
    allBets.push({
        roundId: currentRoundId,
        userId: userId,
        stocks: selectedStocks,
        wager: amount,
        payout: 0,
        result: 'PENDING'
    });
}

function handlePayout(userId: string, data: any) {
    const stats = playerStats.get(userId);
    if (stats) {
        stats.totalWon += data.totalPayout;
        stats.roundsPlayed++;
        if (data.totalPayout > 0) stats.wins++; else stats.losses++;
    }

    const log = roundLogs.get(data.roundId);
    if (log) {
        log.totalPayoutReceived += data.totalPayout;
        log.netHouseProfit += (data.totalWager - data.totalPayout);
    }

    // Update Bet Records (Naive matching: matches last pending bet for this user/round)
    // In real scenario, transactionId should be tracked.
    const userBets = allBets.filter(b => b.roundId === data.roundId && b.userId === userId && b.result === 'PENDING');

    // Distribute payout (simplified for aggregated payout event)
    if (userBets.length > 0) {
        // If multiple bets, we just mark them all processed for now or split
        // Ideally the payout event gives breakdown.
        // Assuming single aggregate for simplicity in this visual report
        userBets.forEach(b => {
            // Heuristic: If total payout > 0, mark as win, else loss
            // To be accurate we need per-bet breakdown from server.
            b.payout = data.totalPayout / userBets.length;
            b.result = data.totalPayout > 0 ? 'WIN' : 'LOSS';
        });
    }
}

// --- EXCEL REPORT ---
async function generateExcelReport() {
    console.log('📊 Generating Excel Report...');
    const workbook = new ExcelJS.Workbook();

    // SHEET 1: ROUND SUMMARY
    const sheet1 = workbook.addWorksheet('Round Summary');
    sheet1.columns = [
        { header: 'Round ID', key: 'id', width: 35 },
        { header: 'Server Time', key: 'time', width: 25 },
        { header: 'Net House Profit', key: 'profit', width: 15 },
        { header: 'Example Outcome', key: 'sample', width: 50 },
    ];
    roundLogs.forEach(log => {
        sheet1.addRow({
            id: log.roundId,
            time: log.serverTime,
            profit: log.netHouseProfit.toFixed(2),
            sample: log.outcomeMessage
        });
    });

    // SHEET 2: STOCK DETAILS (Deep Dive)
    const sheet2 = workbook.addWorksheet('Stock Performance');
    sheet2.columns = [
        { header: 'Round ID', key: 'rid', width: 35 },
        { header: 'Symbol', key: 'sym', width: 12 },
        { header: 'Start Price', key: 'start', width: 15 },
        { header: 'End Price', key: 'end', width: 15 },
        { header: 'Delta %', key: 'delta', width: 12 },
        { header: 'Multiplier Index', key: 'idx', width: 15 },
    ];
    roundLogs.forEach(log => {
        log.stockDetails.forEach(s => {
            sheet2.addRow({
                rid: log.roundId,
                sym: s.symbol,
                start: s.startPrice,
                end: s.endPrice,
                delta: s.delta ? s.delta.toFixed(3) + '%' : '0%',
                idx: s.multiplierIndex
            });
        });
    });

    // SHEET 3: BET ANALYSIS
    const sheet3 = workbook.addWorksheet('Bet Analysis');
    sheet3.columns = [
        { header: 'Round ID', key: 'rid', width: 35 },
        { header: 'User ID', key: 'uid', width: 25 },
        { header: 'Stocks Picked', key: 'picked', width: 30 },
        { header: 'Wager', key: 'wager', width: 12 },
        { header: 'Payout', key: 'payout', width: 12 },
        { header: 'Result', key: 'res', width: 10 },
    ];
    allBets.forEach(b => {
        sheet3.addRow({
            rid: b.roundId,
            uid: b.userId,
            picked: b.stocks.join(', '),
            wager: b.wager,
            payout: b.payout.toFixed(2),
            res: b.result
        });
    });

    // SHEET 4: PLAYER STATS
    const sheet4 = workbook.addWorksheet('Player Stats');
    sheet4.columns = [
        { header: 'User ID', key: 'id', width: 25 },
        { header: 'Rounds', key: 'rounds', width: 10 },
        { header: 'Wager', key: 'wager', width: 12 },
        { header: 'Won', key: 'won', width: 12 },
        { header: 'P/L', key: 'pl', width: 12 },
        { header: 'Wins', key: 'w', width: 8 },
        { header: 'Losses', key: 'l', width: 8 },
        { header: 'Win Rate', key: 'rate', width: 10 },
    ];
    playerStats.forEach(p => {
        const rate = p.roundsPlayed > 0 ? ((p.wins / p.roundsPlayed) * 100).toFixed(1) + '%' : '0%';
        sheet4.addRow({
            id: p.userId,
            rounds: p.roundsPlayed,
            wager: p.totalWager.toFixed(2),
            won: p.totalWon.toFixed(2),
            pl: (p.totalWon - p.totalWager).toFixed(2),
            w: p.wins,
            l: p.losses,
            rate: rate
        });
    });

    await workbook.xlsx.writeFile('Crypto_Gameplay_DeepDive.xlsx');
    console.log('✅ Detailed Report Saved: Crypto_Gameplay_DeepDive.xlsx');
}

// --- MAIN RUNNER ---
async function run() {
    console.log(`🚀 Connecting to Redis: ${CONFIG.REDIS_URL}`);
    await redis.connect();

    console.log(`👥 Spawning ${CONFIG.NUM_USERS} bots in ${CONFIG.MARKET_ROOM}...`);

    for (let i = 0; i < CONFIG.NUM_USERS; i++) {
        await spawnBot(i);
        await new Promise(r => setTimeout(r, 50));
    }

    console.log(`🎮 Game Loop Active. Running for ${CONFIG.TEST_DURATION_MIN} minutes...`);

    await new Promise(r => setTimeout(r, CONFIG.TEST_DURATION_MIN * 60 * 1000));

    console.log('🛑 Test Finished. Generating Report...');
    activeSockets.forEach(s => s.disconnect());

    await generateExcelReport();
    await redis.disconnect();
    process.exit(0);
}

run().catch(e => console.error(e));