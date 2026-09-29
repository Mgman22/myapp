const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Database Connection & WAL Mode for Concurrency Safety
const db = new sqlite3.Database('./betting.db', (err) => {
    if (err) {
        console.error('Database opening error: ', err.message);
    } else {
        console.log('Connected to SQLite Database (betting.db).');
        db.run('PRAGMA journal_mode = WAL;');
        db.run('PRAGMA foreign_keys = ON;');
    }
});

// Mobile / Safari / Server Timezone Safe Date Parser
function parseMatchTime(timeStr) {
    if (!timeStr) return 0;
    let rawTime = String(timeStr).trim();
    if (rawTime.includes(' ') && !rawTime.includes('T')) {
        rawTime = rawTime.replace(' ', 'T');
    }
    const t = new Date(rawTime).getTime();
    return isNaN(t) ? 0 : t;
}

// Database Initialization
db.serialize(() => {
    // 1. Users Table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        balance REAL DEFAULT 0,
        role TEXT DEFAULT 'user'
    )`);

    // 2. Matches Table
    db.run(`CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        league TEXT DEFAULT 'ENGLISH PREMIER LEAGUE',
        custom_match_id TEXT UNIQUE,
        match_name TEXT,
        body_odds TEXT,
        goal_odds TEXT,
        match_time TEXT,
        status TEXT DEFAULT 'Open',
        home_score INTEGER,
        away_score INTEGER
    )`);

    // 3. Bets Table
    db.run(`CREATE TABLE IF NOT EXISTS bets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        match_id TEXT,
        match_name TEXT,
        bet_type TEXT,
        choice TEXT,
        amount REAL,
        odds_rate TEXT,
        status TEXT DEFAULT 'Pending',
        parlay_group_id TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 4. Transactions Table
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        type TEXT,
        payment_method TEXT,
        account_name TEXT,
        phone TEXT,
        amount REAL,
        transaction_id TEXT,
        status TEXT DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 5. Risk Forwards Table
    db.run(`CREATE TABLE IF NOT EXISTS risk_forwards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT,
        choice TEXT,
        amount REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Default Admin Account (Password: admin123)
    const defaultAdminPass = bcrypt.hashSync('admin123', 10);
    db.run(`INSERT OR IGNORE INTO users (username, password, balance, role) VALUES ('admin', ?, 0, 'admin')`, [defaultAdminPass]);

    // Auto-fix: ပွဲချိန်မရောက်သေးသော ပွဲများကို Status: Open သို့ ပြန်ပြောင်းပေးခြင်း
    const nowMs = Date.now();
    db.all(`SELECT id, match_time FROM matches WHERE status = 'Closed'`, [], (err, rows) => {
        if (!err && rows && rows.length > 0) {
            const reopenIds = rows.filter(row => {
                const matchTimeMs = parseMatchTime(row.match_time);
                return matchTimeMs === 0 || matchTimeMs > nowMs;
            }).map(row => row.id);

            if (reopenIds.length > 0) {
                const placeholders = reopenIds.map(() => '?').join(',');
                db.run(`UPDATE matches SET status = 'Open' WHERE id IN (${placeholders})`, reopenIds);
            }
        }
    });
});

// Helper Function: Auto-close expired matches
function checkAndCloseExpiredMatches(callback) {
    const nowMs = Date.now();
    db.all(`SELECT id, match_time FROM matches WHERE status = 'Open'`, [], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            if (callback) callback();
            return;
        }

        const expiredIds = rows.filter(row => {
            const matchTimeMs = parseMatchTime(row.match_time);
            return matchTimeMs > 0 && matchTimeMs <= nowMs;
        }).map(row => row.id);

        if (expiredIds.length > 0) {
            const placeholders = expiredIds.map(() => '?').join(',');
            db.run(`UPDATE matches SET status = 'Closed' WHERE id IN (${placeholders})`, expiredIds, () => {
                if (callback) callback();
            });
        } else {
            if (callback) callback();
        }
    });
}

// ================= ACCURATE MYANMAR SETTLEMENT ENGINE =================
function parseOdds(oddsStr) {
    if (!oddsStr) return { baseGoal: 0, sign: '=', val: 0 };
    let str = oddsStr.toString().trim();
    
    if (str.endsWith('.5')) {
        const bg = Math.floor(parseFloat(str));
        return { baseGoal: bg, sign: '-', val: 100 };
    }

    let sign = '=';
    if (str.includes('+')) sign = '+';
    else if (str.includes('-')) sign = '-';

    const parts = str.split(/[\+\-\=]/);
    const baseGoal = parseInt(parts[0]) || 0;
    const val = parts[1] ? parseInt(parts[1]) : 0;
    return { baseGoal, sign, val };
}

function calculateBetOutcome(betType, choice, oddsStr, homeScore, awayScore, matchName, amount) {
    const totalGoals = Number(homeScore) + Number(awayScore);
    const goalDiff = Number(homeScore) - Number(awayScore);
    const betAmount = Number(amount) || 0;

    const teams = (matchName || '').split(' vs ');
    const homeTeam = teams[0] ? teams[0].trim() : '';

    const { baseGoal, sign, val } = parseOdds(oddsStr);
    let winFactor = 0; 
    const type = (betType || '').toLowerCase();

    if (type.includes('goal') || type.includes('ဂိုးပေါင်း')) {
        let overFactor = 0;
        if (val === 100) { 
            overFactor = (totalGoals > baseGoal) ? 1.0 : -1.0;
        } else if (val === 50) {
            if (sign === '-') { 
                if (totalGoals > baseGoal) overFactor = 1.0;
                else if (totalGoals === baseGoal) overFactor = -0.5; 
                else overFactor = -1.0;
            } else if (sign === '+') { 
                if (totalGoals > baseGoal + 1) overFactor = 1.0;
                else if (totalGoals === baseGoal + 1) overFactor = 0.5; 
                else overFactor = -1.0;
            }
        } else if (sign === '=' || val === 0) { 
            if (totalGoals > baseGoal) overFactor = 1.0;
            else if (totalGoals === baseGoal) overFactor = 0.0; 
            else overFactor = -1.0;
        } else { 
            const perc = val / 100;
            if (totalGoals > baseGoal) overFactor = 1.0;
            else if (totalGoals === baseGoal) overFactor = (sign === '+') ? perc : -perc;
            else overFactor = -1.0;
        }
        const isOver = choice.toLowerCase().includes('over') || choice.toLowerCase().includes('ပေါ်');
        winFactor = isOver ? overFactor : -overFactor;

    } else if (type.includes('body') || type.includes('ဘော်ဒီ')) {
        let favFactor = 0;
        if (val === 100) { 
            favFactor = (goalDiff > baseGoal) ? 1.0 : -1.0;
        } else if (val === 50) {
            if (sign === '-') { 
                if (goalDiff > baseGoal) favFactor = 1.0;
                else if (goalDiff === baseGoal) favFactor = -0.5; 
                else favFactor = -1.0;
            } else if (sign === '+') { 
                if (goalDiff > baseGoal + 1) favFactor = 1.0;
                else if (goalDiff === baseGoal + 1) favFactor = 0.5; 
                else favFactor = -1.0;
            }
        } else if (sign === '=' || val === 0) { 
            if (goalDiff > baseGoal) favFactor = 1.0;
            else if (goalDiff === baseGoal) favFactor = 0.0; 
            else favFactor = -1.0;
        } else { 
            const perc = val / 100;
            if (goalDiff > baseGoal) favFactor = 1.0;
            else if (goalDiff === baseGoal) favFactor = (sign === '+') ? perc : -perc;
            else favFactor = -1.0;
        }

        winFactor = (choice.trim() === homeTeam) ? favFactor : -favFactor;
    }

    let status = 'Lost';
    if (winFactor === 1.0) status = 'Won';
    else if (winFactor === 0.5) status = 'Half Won';
    else if (winFactor === 0.0) status = 'Draw';
    else if (winFactor === -0.5) status = 'Half Lost';
    else if (winFactor === -1.0) status = 'Lost';

    let returnAmount = 0;
    if (winFactor > 0) {
        const grossProfit = betAmount * winFactor;
        const netProfit = grossProfit * 0.95; 
        returnAmount = betAmount + Math.floor(netProfit);
    } else if (winFactor === 0) {
        returnAmount = betAmount; 
    } else {
        returnAmount = Math.floor(betAmount * (1 + winFactor));
    }

    return { status, winFactor, returnAmount };
}

// ================= AUTH APIs ================= //
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username နှင့် Password ထည့်သွင်းပါ။' });
    }

    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(400).json({ success: false, message: 'Invalid username or password' });

        bcrypt.compare(password, row.password, (err, match) => {
            if (err || !match) {
                return res.status(400).json({ success: false, message: 'Invalid username or password' });
            }
            // Password match ဖြစ်ပါက password field ကို ဖယ်ထုတ်ပြီး ပြန်ပို့မည်
            const { password: _, ...userInfo } = row;
            res.json({ success: true, user: userInfo });
        });
    });
});

app.get('/api/user/balance', (req, res) => {
    const { username } = req.query;
    db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, balance: row.balance });
    });
});

// ================= USER MANAGEMENT APIs ================= //
app.get(['/api/users', '/api/admin/users'], (req, res) => {
    db.all(`SELECT id, username, balance, role FROM users WHERE role = 'user' ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

app.post(['/api/users', '/api/admin/create-user'], (req, res) => {
    const { username, password, balance, initial_balance } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username နှင့် Password လိုအပ်ပါသည်။' });
    }
    const initialBal = balance !== undefined ? Number(balance) : (Number(initial_balance) || 0);

    const hashedPassword = bcrypt.hashSync(password, 10);

    db.run(`INSERT INTO users (username, password, balance, role) VALUES (?, ?, ?, 'user')`, 
        [username, hashedPassword, initialBal], function(err) {
        if (err) return res.status(400).json({ success: false, message: 'Username ဖြင့် အကောင့်ရှိပြီးသားဖြစ်ပါသည် သို့မဟုတ် အချက်အလက်မှားယွင်းနေပါသည်။' });
        res.json({ success: true, message: 'User account created successfully', userId: this.lastID });
    });
});

app.post(['/api/users/add-balance', '/api/admin/update-balance'], (req, res) => {
    const { username, amount } = req.body;
    const amt = Number(amount);
    if (isNaN(amt)) return res.status(400).json({ success: false, message: 'ငွေပမာဏ မမှန်ကန်ပါ။' });

    db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amt, username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Balance updated successfully' });
    });
});

// ================= MATCH MANAGEMENT APIs ================= //
app.get(['/api/matches', '/api/admin/matches'], (req, res) => {
    checkAndCloseExpiredMatches(() => {
        db.all(`SELECT * FROM matches ORDER BY id DESC`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, data: rows });
        });
    });
});

app.post(['/api/matches', '/api/admin/add-match'], (req, res) => {
    const { league, custom_match_id, match_name, team_a, team_b, body_odds, goal_odds, match_time } = req.body;
    
    const finalMatchName = match_name || `${team_a} vs ${team_b}`;
    const mId = custom_match_id || ('M-' + Date.now());

    if (!finalMatchName || !match_time) {
        return res.status(400).json({ success: false, message: 'ကျေးဇူးပြု၍ လိုအပ်သောအချက်အလက်များ ပြည့်စုံစွာဖြည့်ပါ' });
    }

    db.run(`INSERT INTO matches (league, custom_match_id, match_name, body_odds, goal_odds, match_time, status) VALUES (?, ?, ?, ?, ?, ?, 'Open')`, 
        [league || 'ENGLISH PREMIER LEAGUE', mId, finalMatchName, body_odds, goal_odds, match_time], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Match added successfully', matchId: this.lastID });
    });
});

app.patch('/api/matches/:id/status', (req, res) => {
    const { status } = req.body;
    db.run(`UPDATE matches SET status = ? WHERE id = ? OR custom_match_id = ?`, [status, req.params.id, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Match status updated successfully' });
    });
});

app.patch('/api/matches/:id/odds', (req, res) => {
    const matchId = req.params.id;
    const { body_odds, goal_odds } = req.body;
    
    const query = `UPDATE matches SET body_odds = ?, goal_odds = ? WHERE id = ? OR custom_match_id = ?`;
    
    db.run(query, [body_odds, goal_odds, matchId, matchId], function(err) {
        if (err) {
            console.error('Odds update error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ success: false, message: 'Match not found' });
        }

        res.json({ success: true, message: 'ပွဲစဉ်ကြေးများကို အောင်မြင်စွာ ပြင်ဆင်ပြီးပါပြီ။' });
    });
});

app.delete(['/api/matches/:id', '/api/admin/delete-match'], (req, res) => {
    const matchId = req.params.id || req.body.match_id;
    db.run(`DELETE FROM matches WHERE id = ? OR custom_match_id = ?`, [matchId, matchId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Match deleted successfully' });
    });
});

// ================= MATCH SETTLEMENT API (WITH TRANSACTION SAFETY) ================= //
app.post(['/api/matches/save-result', '/api/admin/update-result'], (req, res) => {
    const { match_id, home_score, away_score } = req.body;

    db.get(`SELECT * FROM matches WHERE id = ? OR custom_match_id = ?`, [match_id, match_id], (err, match) => {
        if (err || !match) return res.status(404).json({ success: false, message: 'Match not found' });

        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);

            db.run(`UPDATE matches SET home_score = ?, away_score = ?, status = 'Finished' WHERE id = ?`, 
                [home_score, away_score, match.id], (err) => {
                if (err) {
                    db.run(`ROLLBACK`);
                    return res.status(500).json({ success: false, error: err.message });
                }

                db.all(`SELECT * FROM bets WHERE (match_id = ? OR match_id = ?) AND status = 'Pending'`, [match.custom_match_id, match.id], (err, bets) => {
                    if (err) {
                        db.run(`ROLLBACK`);
                        return res.status(500).json({ success: false, error: err.message });
                    }

                    if (!bets || bets.length === 0) {
                        db.run(`COMMIT`);
                        return res.json({ success: true, message: 'Match result saved! No pending bets to settle.' });
                    }

                    let completedCount = 0;
                    let hasError = false;

                    bets.forEach(bet => {
                        const odds = (bet.bet_type.toLowerCase().includes('body') || bet.bet_type.includes('ဘော်ဒီ')) ? match.body_odds : match.goal_odds;
                        const outcome = calculateBetOutcome(
                            bet.bet_type,
                            bet.choice,
                            odds,
                            home_score,
                            away_score,
                            match.match_name,
                            bet.amount
                        );

                        db.run(`UPDATE bets SET status = ? WHERE id = ?`, [outcome.status, bet.id], (err) => {
                            if (err) hasError = true;

                            if (outcome.returnAmount > 0) {
                                db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [outcome.returnAmount, bet.username]);
                                db.run(`INSERT INTO transactions (username, type, payment_method, amount, status, created_at) VALUES (?, 'Payout', 'Wallet', ?, 'Success', CURRENT_TIMESTAMP)`, [bet.username, outcome.returnAmount]);
                            }
                            
                            completedCount++;
                            if (completedCount === bets.length) {
                                if (hasError) {
                                    db.run(`ROLLBACK`);
                                    return res.status(500).json({ success: false, message: 'Error during settlement.' });
                                } else {
                                    db.run(`COMMIT`);
                                    return res.json({ success: true, message: 'Match result saved and all bets settled successfully!' });
                                }
                            }
                        });
                    });
                });
            });
        });
    });
});

// ================= BETTING APIs (WITH TRANSACTION SAFETY) ================= //
app.get(['/api/bets', '/api/admin/bets'], (req, res) => {
    const { username } = req.query;
    let query = `SELECT * FROM bets`;
    let params = [];
    if (username) {
        query += ` WHERE username = ?`;
        params.push(username);
    }
    query += ` ORDER BY id DESC`;

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

app.get('/api/user/bets', (req, res) => {
    const { username } = req.query;
    let query = `SELECT * FROM bets`;
    let params = [];
    if (username) {
        query += ` WHERE username = ?`;
        params.push(username);
    }
    query += ` ORDER BY id DESC`;

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

app.delete('/api/bets/:id', (req, res) => {
    db.run(`DELETE FROM bets WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Bet record deleted successfully' });
    });
});

app.post('/api/user/place-bet', (req, res) => {
    const { username, bets, is_parlay, total_amount } = req.body;
    
    let incomingBets = bets;
    if (!incomingBets && req.body.match_id) {
        incomingBets = [{
            match_id: req.body.match_id,
            match_name: req.body.match_name,
            bet_type: req.body.bet_type,
            choice: req.body.choice,
            odds_rate: req.body.odds_rate,
            amount: req.body.amount
        }];
    }

    if (!incomingBets || incomingBets.length === 0) {
        return res.status(400).json({ success: false, message: 'လောင်းမည့်ပွဲစဉ်များ မရှိပါ။' });
    }

    const totalDeduction = is_parlay ? Number(total_amount) : incomingBets.reduce((sum, b) => sum + Number(b.amount), 0);
    if (isNaN(totalDeduction) || totalDeduction <= 0) {
        return res.status(400).json({ success: false, message: 'ငွေပမာဏ မမှန်ကန်ပါ။' });
    }

    db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, user) => {
        if (err || !user) return res.status(400).json({ success: false, message: 'User not found' });
        if (user.balance < totalDeduction) return res.status(400).json({ success: false, message: 'လက်ကျန်ငွေ မလုံလောက်ပါ။' });

        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);

            db.run(`UPDATE users SET balance = balance - ? WHERE username = ?`, [totalDeduction, username], (err) => {
                if (err) {
                    db.run(`ROLLBACK`);
                    return res.status(500).json({ success: false, error: err.message });
                }

                const parlayGroupId = is_parlay ? 'PARLAY-' + Date.now() : null;
                let completed = 0;
                let hasError = false;

                incomingBets.forEach(b => {
                    db.run(`INSERT INTO bets (username, match_id, match_name, bet_type, choice, amount, odds_rate, status, parlay_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
                        [username, b.match_id, b.match_name, b.bet_type, b.choice, is_parlay ? (completed === 0 ? totalDeduction : 0) : b.amount, b.odds_rate, parlayGroupId], (err) => {
                        if (err) hasError = true;
                        completed++;

                        if (completed === incomingBets.length) {
                            if (hasError) {
                                db.run(`ROLLBACK`);
                                return res.status(500).json({ success: false, message: 'Failed to place bet.' });
                            } else {
                                db.run(`INSERT INTO transactions (username, type, payment_method, amount, status, created_at) VALUES (?, ?, 'Wallet', ?, 'Completed', CURRENT_TIMESTAMP)`, 
                                    [username, is_parlay ? 'Parlay Bet' : 'Bet Placed', totalDeduction], () => {
                                    db.run(`COMMIT`);
                                    res.json({ success: true, message: 'Successfully placed bet(s)' });
                                });
                            }
                        }
                    });
                });
            });
        });
    });
});

// ================= DEPOSIT, WITHDRAW & ADMIN APPROVAL APIs ================= //
app.post('/api/user/deposit', (req, res) => {
    const { username, payment_method, amount, transaction_id } = req.body;
    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ success: false, message: 'ငွေပမာဏ မမှန်ကန်ပါ။' });

    db.run(`INSERT INTO transactions (username, type, payment_method, amount, transaction_id, status, created_at) VALUES (?, 'Deposit', ?, ?, ?, 'Pending', CURRENT_TIMESTAMP)`,
        [username, payment_method, amt, transaction_id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Deposit request submitted successfully' });
    });
});

app.post('/api/user/withdraw', (req, res) => {
    const { username, payment_method, account_name, phone, amount } = req.body;
    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ success: false, message: 'ငွေပမာဏ မမှန်ကန်ပါ။' });
    
    db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, user) => {
        if (err || !user) return res.status(400).json({ success: false, message: 'User not found' });
        if (user.balance < amt) return res.status(400).json({ success: false, message: 'Insufficient balance' });

        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);

            db.run(`UPDATE users SET balance = balance - ? WHERE username = ?`, [amt, username], (err) => {
                if (err) {
                    db.run(`ROLLBACK`);
                    return res.status(500).json({ success: false, error: err.message });
                }

                db.run(`INSERT INTO transactions (username, type, payment_method, account_name, phone, amount, status, created_at) VALUES (?, 'Withdraw', ?, ?, ?, ?, 'Pending', CURRENT_TIMESTAMP)`,
                    [username, payment_method, account_name, phone, amt], function(err) {
                    if (err) {
                        db.run(`ROLLBACK`);
                        return res.status(500).json({ success: false, error: err.message });
                    }
                    db.run(`COMMIT`);
                    res.json({ success: true, message: 'Withdraw request submitted successfully' });
                });
            });
        });
    });
});

app.get('/api/user/transactions', (req, res) => {
    const { username } = req.query;
    let query = `SELECT * FROM transactions`;
    let params = [];
    if (username) {
        query += ` WHERE username = ?`;
        params.push(username);
    }
    query += ` ORDER BY id DESC`;

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

// Admin Transaction Action API (Approve / Reject) with Transaction Safety
app.post('/api/admin/transactions/action', (req, res) => {
    const { transaction_id, status, username, amount, type } = req.body; 
    const amt = Number(amount);

    db.serialize(() => {
        db.run(`BEGIN TRANSACTION`);

        db.run(`UPDATE transactions SET status = ? WHERE id = ?`, [status, transaction_id], function(err) {
            if (err) {
                db.run(`ROLLBACK`);
                return res.status(500).json({ success: false, error: err.message });
            }

            if (status === 'Approved' && type === 'Deposit') {
                db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amt, username]);
            }
            
            if (status === 'Rejected' && type === 'Withdraw') {
                db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amt, username]);
            }

            db.run(`COMMIT`);
            res.json({ success: true, message: `ငွေစာရင်း တောင်းဆိုမှုမှာ ${status} ဖြစ်သွားပါပြီ။` });
        });
    });
});

// ================= RISK MANAGEMENT API ================= //
app.post('/api/admin/forward-risk', (req, res) => {
    const { match_id, choice, amount } = req.body;
    if (!match_id || !choice || !amount) {
        return res.status(400).json({ success: false, message: 'အချက်အလက်များ ပြည့်စုံစွာ ဖြည့်ပါ' });
    }

    db.run(`INSERT INTO risk_forwards (match_id, choice, amount) VALUES (?, ?, ?)`, [match_id, choice, amount], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Risk transferred successfully', forwardId: this.lastID });
    });
});

// Static Fallback Routes
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server Start
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Admin Panel: http://localhost:${PORT}/admin`);
});