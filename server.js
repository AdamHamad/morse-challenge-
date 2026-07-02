const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Explicitly route HTML and CSS from root to avoid exposing server files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/morse.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'style.css'));
});

const DB_FILE = path.join(__dirname, 'database.json');
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_URL = process.env.DATABASE_URL;
let isMongo = false;
let isPg = false;
let pgPool = null;

// Define Mongoose Schema for MongoDB
const userSchema = new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    name: { type: String, required: true },
    group: { type: String, required: true },
    rank: { type: String, required: true },
    score: { type: Number, default: 0 },
    currentWord: { type: String, default: "" }
});
const User = mongoose.model('User', userSchema);

// Connect to Database based on availability
if (DATABASE_URL) {
    console.log("Attempting to connect to PostgreSQL...");
    pgPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    // Prevent idle client errors from crashing the server process (like ECONNRESET)
    pgPool.on('error', (err, client) => {
        console.error("Unexpected error on idle pg client:", err);
    });

    pgPool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(50) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            scout_group VARCHAR(255) NOT NULL,
            rank VARCHAR(255) NOT NULL,
            score INT DEFAULT 0,
            current_word VARCHAR(255) DEFAULT ''
        );
    `)
    .then(() => {
        console.log("Connected to PostgreSQL successfully! Using cloud relational database.");
        isPg = true;
    })
    .catch(err => {
        console.error("PostgreSQL connection failed! Falling back to other databases.", err);
        isPg = false;
        if (MONGODB_URI) {
            connectMongo();
        }
    });
} else if (MONGODB_URI) {
    connectMongo();
} else {
    console.log("No cloud database URI env variables found. Using local JSON database.");
}

function connectMongo() {
    console.log("Attempting to connect to MongoDB...");
    mongoose.connect(MONGODB_URI)
        .then(() => {
            console.log("Connected to MongoDB successfully! Using cloud database.");
            isMongo = true;
        })
        .catch(err => {
            console.error("MongoDB connection failed! Falling back to local JSON database.", err);
            isMongo = false;
        });
}

// Local Database Helpers
function readDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2), 'utf8');
        return { users: [] };
    }
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        console.error("Error reading database, resetting...", e);
        return { users: [] };
    }
}

function writeDatabase(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error("Error writing database", e);
    }
}

// Morse Dictionary for server-side translation
const morseDict = {
    'أ': '._', 'ب': '_...', 'ت': '_', 'ث': '_._.', 'ج': '._ _ _', 
    'ح': '....', 'خ': '_ _ _', 'د': '_..', 'ذ': '_ _ ..', 'ر': '._.', 
    'ز': '_ _ _ .', 'س': '...', 'ش': '_ _ _ _', 'ص': '_.._', 'ض': '..._', 
    'ط': '.._', 'ظ': '_ _ . _', 'ع': '._._', 'غ': '_ _ .', 'ف': '.._.', 
    'ق': '_ . _ _', 'ك': '_._', 'ل': '._..', 'م': '_ _', 'ن': '_.', 
    'ه': '.._..', 'و': '. _ _', 'ي': '..', 'ء': '.','ة': '_','ا':'._','آ': '._','ئ':'.'
};

const words = require('./words.js');

function translateToMorse(word) {
    if (!word) return "";
    return word.split('').map(char => {
        return morseDict[char] || char;
    }).join(' / ');
}

function getRandomWord() {
    return words[Math.floor(Math.random() * words.length)];
}

// APIs

// Login endpoint: registers or resumes session for user
app.post('/api/login', async (req, res) => {
    const { name, group, rank } = req.body;
    if (!name || !group || !rank) {
        return res.status(400).json({ error: "جميع الحقول مطلوبة" });
    }

    const trimmedName = name.trim();
    const trimmedGroup = group.trim();
    const trimmedRank = rank.trim();

    try {
        if (isPg) {
            const { rows } = await pgPool.query(
                'SELECT id, name, scout_group AS "group", rank, score, current_word AS "currentWord" FROM users WHERE name = $1 AND scout_group = $2 AND rank = $3',
                [trimmedName, trimmedGroup, trimmedRank]
            );
            let user = rows[0];

            if (!user) {
                const newId = Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
                const newWord = getRandomWord();
                const insertResult = await pgPool.query(
                    'INSERT INTO users (id, name, scout_group, rank, score, current_word) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, scout_group AS "group", rank, score, current_word AS "currentWord"',
                    [newId, trimmedName, trimmedGroup, trimmedRank, 0, newWord]
                );
                user = insertResult.rows[0];
            } else if (!user.currentWord) {
                const newWord = getRandomWord();
                const updateResult = await pgPool.query(
                    'UPDATE users SET current_word = $1 WHERE id = $2 RETURNING id, name, scout_group AS "group", rank, score, current_word AS "currentWord"',
                    [newWord, user.id]
                );
                user = updateResult.rows[0];
            }

            return res.json({
                id: user.id,
                name: user.name,
                group: user.group,
                rank: user.rank,
                score: user.score
            });
        } else if (isMongo) {
            let user = await User.findOne({ name: trimmedName, group: trimmedGroup, rank: trimmedRank });
            if (!user) {
                user = new User({
                    id: Math.random().toString(36).substring(2, 11) + Date.now().toString(36),
                    name: trimmedName,
                    group: trimmedGroup,
                    rank: trimmedRank,
                    score: 0,
                    currentWord: getRandomWord()
                });
                await user.save();
            } else if (!user.currentWord) {
                user.currentWord = getRandomWord();
                await user.save();
            }
            return res.json({
                id: user.id,
                name: user.name,
                group: user.group,
                rank: user.rank,
                score: user.score
            });
        } else {
            // Local JSON DB
            const db = readDatabase();
            let user = db.users.find(u => 
                u.name.trim() === trimmedName && 
                u.group.trim() === trimmedGroup && 
                u.rank.trim() === trimmedRank
            );

            if (!user) {
                user = {
                    id: Math.random().toString(36).substring(2, 11) + Date.now().toString(36),
                    name: trimmedName,
                    group: trimmedGroup,
                    rank: trimmedRank,
                    score: 0,
                    currentWord: getRandomWord()
                };
                db.users.push(user);
                writeDatabase(db);
            } else if (!user.currentWord) {
                user.currentWord = getRandomWord();
                writeDatabase(db);
            }
            return res.json({
                id: user.id,
                name: user.name,
                group: user.group,
                rank: user.rank,
                score: user.score
            });
        }
    } catch (e) {
        console.error("Login error:", e);
        res.status(500).json({ error: "حدث خطأ في الخادم" });
    }
});

// Fetch current challenge for a user
app.get('/api/challenge', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: "معرف المستخدم مطلوب" });
    }

    try {
        if (isPg) {
            const { rows } = await pgPool.query(
                'SELECT id, current_word AS "currentWord" FROM users WHERE id = $1',
                [userId]
            );
            let user = rows[0];
            if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

            if (!user.currentWord) {
                const newWord = getRandomWord();
                await pgPool.query('UPDATE users SET current_word = $1 WHERE id = $2', [newWord, userId]);
                user.currentWord = newWord;
            }
            return res.json({ morse: translateToMorse(user.currentWord) });
        } else if (isMongo) {
            const user = await User.findOne({ id: userId });
            if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
            
            if (!user.currentWord) {
                user.currentWord = getRandomWord();
                await user.save();
            }
            return res.json({ morse: translateToMorse(user.currentWord) });
        } else {
            const db = readDatabase();
            const user = db.users.find(u => u.id === userId);
            if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
            
            if (!user.currentWord) {
                user.currentWord = getRandomWord();
                writeDatabase(db);
            }
            return res.json({ morse: translateToMorse(user.currentWord) });
        }
    } catch (e) {
        console.error("Fetch challenge error:", e);
        res.status(500).json({ error: "حدث خطأ في الخادم" });
    }
});

// Skip the current word and get a new one
app.post('/api/skip', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: "معرف المستخدم مطلوب" });
    }

    try {
        const newWord = getRandomWord();
        if (isPg) {
            const { rowCount } = await pgPool.query(
                'UPDATE users SET current_word = $1 WHERE id = $2',
                [newWord, userId]
            );
            if (rowCount === 0) return res.status(404).json({ error: "المستخدم غير موجود" });
            return res.json({ morse: translateToMorse(newWord) });
        } else if (isMongo) {
            const user = await User.findOne({ id: userId });
            if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
            user.currentWord = newWord;
            await user.save();
            return res.json({ morse: translateToMorse(newWord) });
        } else {
            const db = readDatabase();
            const user = db.users.find(u => u.id === userId);
            if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
            user.currentWord = newWord;
            writeDatabase(db);
            return res.json({ morse: translateToMorse(newWord) });
        }
    } catch (e) {
        console.error("Skip error:", e);
        res.status(500).json({ error: "حدث خطأ في الخادم" });
    }
});

// Submit answer
app.post('/api/answer', async (req, res) => {
    const { userId, answer } = req.body;
    if (!userId || answer === undefined) {
        return res.status(400).json({ error: "المعطيات غير مكتملة" });
    }

    try {
        const newWord = getRandomWord();

        if (isPg) {
            const { rows } = await pgPool.query(
                'SELECT id, current_word AS "currentWord", score FROM users WHERE id = $1',
                [userId]
            );
            const user = rows[0];
            if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

            const isCorrect = (answer.trim() === user.currentWord.trim());
            const oldWord = user.currentWord;
            let newScore = user.score;

            if (isCorrect) {
                newScore += 5;
            } else {
                newScore = Math.max(0, newScore - 3);
            }

            await pgPool.query(
                'UPDATE users SET score = $1, current_word = $2 WHERE id = $3',
                [newScore, newWord, userId]
            );

            return res.json({
                correct: isCorrect,
                correctAnswer: oldWord,
                score: newScore,
                nextMorse: translateToMorse(newWord)
            });
        } else if (isMongo) {
            const user = await User.findOne({ id: userId });
            if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

            const isCorrect = (answer.trim() === user.currentWord.trim());
            const oldWord = user.currentWord;

            if (isCorrect) {
                user.score += 5;
            } else {
                user.score = Math.max(0, user.score - 3);
            }

            user.currentWord = newWord;
            await user.save();

            return res.json({
                correct: isCorrect,
                correctAnswer: oldWord,
                score: user.score,
                nextMorse: translateToMorse(newWord)
            });
        } else {
            const db = readDatabase();
            const user = db.users.find(u => u.id === userId);
            if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

            const isCorrect = (answer.trim() === user.currentWord.trim());
            const oldWord = user.currentWord;

            if (isCorrect) {
                user.score += 5;
            } else {
                user.score = Math.max(0, user.score - 3);
            }

            user.currentWord = newWord;
            writeDatabase(db);

            return res.json({
                correct: isCorrect,
                correctAnswer: oldWord,
                score: user.score,
                nextMorse: translateToMorse(newWord)
            });
        }
    } catch (e) {
        console.error("Submit answer error:", e);
        res.status(500).json({ error: "حدث خطأ في الخادم" });
    }
});

// Get Top 15 Leaderboard
app.get('/api/leaderboard', async (req, res) => {
    try {
        if (isPg) {
            const { rows } = await pgPool.query(
                'SELECT name, scout_group AS "group", rank, score FROM users ORDER BY score DESC LIMIT 15'
            );
            return res.json(rows);
        } else if (isMongo) {
            const leaderboard = await User.find({}, 'name group rank score')
                .sort({ score: -1 })
                .limit(15);
            return res.json(leaderboard);
        } else {
            const db = readDatabase();
            const leaderboard = db.users
                .map(u => ({
                    name: u.name,
                    group: u.group,
                    rank: u.rank,
                    score: u.score
                }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 15);
            return res.json(leaderboard);
        }
    } catch (e) {
        console.error("Fetch leaderboard error:", e);
        res.status(500).json({ error: "حدث خطأ في الخادم" });
    }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`To access from other devices on the network, use http://[YOUR-IP]:${PORT}`);
});
