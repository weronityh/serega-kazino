const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const { RTP_CONFIG, round2, playOlympusSpin, playDogHouseSpin, playBonanzaSpin } = require('./slotsEngine');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const JWT_SECRET = process.env.JWT_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET;
const ADMIN_NICK = process.env.ADMIN_NICK || 'Seregablatnou';
const STARS_CREDIT_RATE = 1.0;

function normalizeMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(Math.min(n, 10000000) * 100) / 100;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calcHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  if (calcHash !== hash) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 86400) return null;
  return JSON.parse(params.get('user'));
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Сессия истекла' });
  }
}

function signUserToken(nick) {
  return jwt.sign({ nick, isAdmin: nick === ADMIN_NICK }, JWT_SECRET, { expiresIn: '7d' });
}

app.get('/', (req, res) => res.send('Kazik API OK'));

// 1. Авто-вход через Telegram Mini App
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const tgUser = verifyTelegramInitData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: 'Неверная подпись Telegram' });

    const rawNick = tgUser.username || `tg_${tgUser.id}`;
    const nick = String(rawNick).replace(/[\/\\.#$\[\]]/g, '_').slice(0, 25);
    const ref = db.collection('players').doc(nick);

    const player = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) return snap.data();
      const fresh = {
        nick,
        tgId: tgUser.id,
        balance: 0.49,
        banned: false,
        stats: { games: 0, wagered: 0, totalWon: 0, biggestWin: 0 },
        fsState: {},
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      tx.set(ref, fresh);
      return fresh;
    });

    if (player.banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });
    res.json({
      token: signUserToken(nick),
      player: { nick, balance: player.balance, stats: player.stats || {}, fsState: player.fsState || {}, isAdmin: nick === ADMIN_NICK }
    });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 2. Вход / регистрация по логину и паролю (из браузера)
app.post('/api/auth/login', async (req, res) => {
  try {
    const nick = String(req.body.nick || '').trim();
    const pass = String(req.body.password || '').trim();
    if (!/^[A-Za-z0-9_]{5,20}$/.test(nick)) return res.status(400).json({ error: 'Ник: 5-20 символов (A-Z, 0-9, _)' });
    if (!/^[A-Za-z0-9_!@#$%^&*.-]{5,32}$/.test(pass)) return res.status(400).json({ error: 'Некорректный пароль' });

    const ref = db.collection('players').doc(nick);
    const player = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const d = snap.data();
        if (!d.passSalt || !d.passHash) return { error: 'Аккаунт привязан к Telegram' };
        if (hashPassword(pass, d.passSalt) !== d.passHash) return { error: 'Неверный пароль' };
        return d;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const fresh = {
        nick,
        passSalt: salt,
        passHash: hashPassword(pass, salt),
        balance: 0.49,
        banned: false,
        stats: { games: 0, wagered: 0, totalWon: 0, biggestWin: 0 },
        fsState: {},
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      tx.set(ref, fresh);
      return fresh;
    });

    if (player.error) return res.status(403).json({ error: player.error });
    if (player.banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });

    res.json({
      token: signUserToken(nick),
      player: { nick, balance: player.balance, stats: player.stats || {}, fsState: player.fsState || {}, isAdmin: nick === ADMIN_NICK }
    });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 3. Текущий профиль и баланс
app.get('/api/me', authMiddleware, async (req, res) => {
  const snap = await db.collection('players').doc(req.user.nick).get();
  if (!snap.exists) return res.status(404).json({ error: 'Игрок не найден' });
  const d = snap.data();
  res.json({ nick: d.nick, balance: d.balance, stats: d.stats || {}, fsState: d.fsState || {}, isAdmin: req.user.isAdmin });
});

// 4. Спины и покупка бонуса
app.post('/api/slots/:slot/spin', authMiddleware, async (req, res) => {
  const slot = req.params.slot;
  if (!['olympus', 'doghouse', 'bonanza'].includes(slot)) return res.status(400).json({ error: 'Неизвестный слот' });

  const isBuyBonus = Boolean(req.body.buyBonus);
  let baseBet = round2(Number(req.body.bet));
  if (!Number.isFinite(baseBet) || baseBet < 0.5 || baseBet > 50) return res.status(400).json({ error: 'Ставка от 0.5 до 50 ⭐' });
  baseBet = Math.round(baseBet * 2) / 2;
  const ante = !isBuyBonus && Boolean(req.body.ante);

  try {
    const slotsSettings = (await db.collection('settings').doc('slots').get()).data() || {};
    if (slotsSettings[slot]) return res.status(403).json({ error: 'Слот временно закрыт' });

    const playerRef = db.collection('players').doc(req.user.nick);
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(playerRef);
      if (!snap.exists) throw new Error('Игрок не найден');
      const p = snap.data();
      if (p.banned) throw new Error('Аккаунт заблокирован');

      const fsState = p.fsState || {};
      const activeFS = fsState[slot] || null;
      let balance = normalizeMoney(p.balance);
      const stats = p.stats || { games: 0, wagered: 0, totalWon: 0, biggestWin: 0 };

      let cost = 0;
      let spinBet = baseBet;
      let inFS = false;

      if (activeFS && activeFS.left > 0) {
        if (isBuyBonus) throw new Error('Бонус уже активен');
        inFS = true;
        spinBet = activeFS.lockedBet;
      } else if (isBuyBonus) {
        if (slot === 'doghouse') throw new Error('Покупка бонуса недоступна');
        cost = round2(baseBet * (slot === 'olympus' ? RTP_CONFIG.AO_BUY_COST_X : RTP_CONFIG.SB_BUY_COST_X));
      } else {
        cost = ante && slot !== 'doghouse' ? round2(baseBet * 1.25) : baseBet;
      }

      if (cost > 0 && balance < cost) throw new Error('Недостаточно средств');
      balance = normalizeMoney(balance - cost);
      stats.wagered = normalizeMoney(stats.wagered + cost);
      if (!isBuyBonus) stats.games = (stats.games || 0) + 1;

      let outcome;
      if (slot === 'olympus') {
        if (isBuyBonus) {
          fsState.olympus = { left: 15, lockedBet: baseBet, totalMultiplier: 0, totalWin: 0 };
          tx.update(playerRef, { balance, stats, fsState });
          return { action: 'bonus_bought', fsLeft: 15, balance, stats };
        }
        outcome = playOlympusSpin({
          baseBet: spinBet,
          ante: inFS ? false : ante,
          inFS,
          totalMultiplier: inFS ? activeFS.totalMultiplier : 0,
          fsTotalWin: inFS ? activeFS.totalWin : 0
        });
      } else if (slot === 'doghouse') {
        outcome = playDogHouseSpin({
          baseBet: spinBet,
          inFS,
          stickyWilds: inFS ? activeFS.stickyWilds : null,
          fsTotalWin: inFS ? activeFS.totalWin : 0
        });
      } else {
        outcome = playBonanzaSpin({
          baseBet: spinBet,
          ante: inFS ? false : ante,
          inFS: inFS || isBuyBonus,
          fsTotalWin: inFS ? activeFS.totalWin : 0,
          forceBonusScatter: isBuyBonus
        });
      }

      balance = normalizeMoney(balance + outcome.finalWin);
      stats.totalWon = normalizeMoney(stats.totalWon + outcome.finalWin);
      if (outcome.finalWin > (stats.biggestWin || 0)) stats.biggestWin = outcome.finalWin;

      if (inFS) {
        activeFS.left -= 1;
        activeFS.left += (outcome.retriggerFS || 0);
        activeFS.totalWin = round2((activeFS.totalWin || 0) + outcome.finalWin);
        if (slot === 'olympus') activeFS.totalMultiplier = outcome.newTotalMultiplier;
        if (slot === 'doghouse') activeFS.stickyWilds = outcome.stickyWilds;
        if (activeFS.left <= 0) delete fsState[slot];
      } else if (isBuyBonus && slot === 'bonanza') {
        fsState.bonanza = { left: 9, lockedBet: baseBet, totalWin: outcome.finalWin };
      } else if (outcome.triggeredFS > 0) {
        fsState[slot] = {
          left: outcome.triggeredFS,
          lockedBet: spinBet,
          totalWin: 0,
          totalMultiplier: 0
        };
        if (slot === 'doghouse') {
          fsState[slot].stickyWilds = Array.from({ length: 5 }, () => Array(3).fill(null));
        }
      }

      tx.update(playerRef, { balance, stats, fsState });
      return { action: 'spin', balance, stats, fsState: fsState[slot] || null, outcome };
    });

    if (result.outcome && result.outcome.finalWin >= 5) {
      const slotNames = { olympus: 'Gates of Olympus', doghouse: 'The Dog House', bonanza: 'Sweet Bonanza' };
      db.collection('recent_wins').add({
        nick: req.user.nick,
        slot: slotNames[slot],
        amount: result.outcome.finalWin,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    }

    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Ошибка спина' });
  }
});

// 5. Создание счёта Telegram Stars
app.post('/api/deposit/stars', authMiddleware, async (req, res) => {
  try {
    const amount = Math.floor(Number(req.body.amount));
    if (!Number.isInteger(amount) || amount < 100 || amount > 100000) {
      return res.status(400).json({ error: 'Сумма от 100 до 100 000 ⭐' });
    }

    const depRef = await db.collection('deposits').add({
      nick: req.user.nick,
      amount,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const tgResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Пополнение ${amount} ⭐`,
        description: `Зачисление на баланс игрока ${req.user.nick}`,
        payload: depRef.id,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Telegram Stars', amount }]
      })
    });
    const tgData = await tgResp.json();
    if (!tgData.ok) return res.status(500).json({ error: tgData.description || 'Ошибка Telegram API' });

    res.json({ invoiceLink: tgData.result });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка создания счёта' });
  }
});

// 6. Webhook от Telegram (авто-зачисление Stars)
app.post('/api/telegram/webhook', async (req, res) => {
  if (TG_WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== TG_WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  const update = req.body;

  if (update.pre_checkout_query) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
    });
    return res.sendStatus(200);
  }

  const payment = update.message && update.message.successful_payment;
  if (payment && payment.currency === 'XTR') {
    const depId = payment.invoice_payload;
    const paidStars = payment.total_amount;
    const depRef = db.collection('deposits').doc(depId);

    await db.runTransaction(async tx => {
      const depSnap = await tx.get(depRef);
      if (!depSnap.exists || depSnap.data().status === 'paid') return;
      const nick = depSnap.data().nick;
      const pRef = db.collection('players').doc(nick);
      const pSnap = await tx.get(pRef);
      if (!pSnap.exists) return;

      const credited = Math.floor(paidStars * STARS_CREDIT_RATE);
      const nextBal = normalizeMoney((pSnap.data().balance || 0) + credited);
      tx.update(pRef, { balance: nextBal });
      tx.update(depRef, { status: 'paid', paidStars, paidAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  }
  res.sendStatus(200);
});

// 7. Заявка на вывод
app.post('/api/withdraw', authMiddleware, async (req, res) => {
  const amount = Math.floor(Number(req.body.amount));
  const requisites = String(req.body.requisites || '').trim().slice(0, 120);
  if (!Number.isInteger(amount) || amount < 500) return res.status(400).json({ error: 'Минимум 500 ⭐' });
  if (requisites.length < 3) return res.status(400).json({ error: 'Укажите @username' });

  try {
    const pRef = db.collection('players').doc(req.user.nick);
    const out = await db.runTransaction(async tx => {
      const snap = await tx.get(pRef);
      const bal = normalizeMoney(snap.data().balance);
      if (bal < amount) throw new Error('Недостаточно средств');
      const nextBal = normalizeMoney(bal - amount);
      tx.update(pRef, { balance: nextBal });
      const wdRef = db.collection('withdrawals').doc();
      tx.set(wdRef, {
        nick: req.user.nick,
        amount,
        method: 'stars',
        requisites,
        status: 'В обработке',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { balance: nextBal, id: wdRef.id };
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/withdraw/history', authMiddleware, async (req, res) => {
  const snap = await db.collection('withdrawals').where('nick', '==', req.user.nick).limit(15).get();
  const list = snap.docs
    .map(d => ({ id: d.id, ...d.data(), _ts: d.data().createdAt?.toMillis?.() || 0 }))
    .sort((a, b) => b._ts - a._ts);
  res.json(list);
});

// 8. Админ-маршруты (только для ADMIN_NICK)
function adminOnly(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Доступ запрещён' });
  next();
}

app.post('/api/admin/balance', authMiddleware, adminOnly, async (req, res) => {
  const nick = String(req.body.nick || req.user.nick).trim();
  const delta = Number(req.body.delta);
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'Некорректная сумма' });

  const ref = db.collection('players').doc(nick);
  const nextBal = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? normalizeMoney(snap.data().balance) : 0;
    const next = normalizeMoney(cur + delta);
    tx.set(ref, { nick, balance: next }, { merge: true });
    return next;
  });
  res.json({ nick, balance: nextBal });
});

app.post('/api/admin/ban', authMiddleware, adminOnly, async (req, res) => {
  const nick = String(req.body.nick || '').trim();
  await db.collection('players').doc(nick).set({ banned: Boolean(req.body.banned) }, { merge: true });
  res.json({ ok: true });
});

app.post('/api/admin/slot-toggle', authMiddleware, adminOnly, async (req, res) => {
  const { slot, closed } = req.body;
  if (!['olympus', 'doghouse', 'bonanza'].includes(slot)) return res.status(400).json({ error: 'bad slot' });
  await db.collection('settings').doc('slots').set({ [slot]: Boolean(closed) }, { merge: true });
  res.json({ ok: true });
});

app.get('/api/admin/players', authMiddleware, adminOnly, async (req, res) => {
  const snap = await db.collection('players').limit(50).get();
  res.json(snap.docs.map(d => ({ nick: d.id, balance: d.data().balance, banned: !!d.data().banned })));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log('Server running on', PORT));
}
module.exports = app;
