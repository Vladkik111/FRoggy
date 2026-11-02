// Froggy Casino — DEMO prototype. Тільки віртуальні демо-кредити, без грошей.
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DEV = process.env.DEV === '1'; // дозволяє запуск без Telegram (лише локально)
const db = new Database('casino.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT,username TEXT,photo TEXT,balance INTEGER DEFAULT 1000,last_topup INTEGER DEFAULT 0,cases INTEGER DEFAULT 0,games INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT,uid INTEGER,kind TEXT,title TEXT,delta INTEGER,item TEXT,ts INTEGER);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT,uid INTEGER,name TEXT,rarity TEXT,ts INTEGER);
CREATE TABLE IF NOT EXISTS rounds(uid INTEGER PRIMARY KEY,kind TEXT,data TEXT,start INTEGER);`);

const rnd = () => crypto.randomInt(0, 1e9) / 1e9;
const pick = a => a[crypto.randomInt(0, a.length)];

const CASES = {
  c10:  { price: 10,   chance: .01, name: 'Starter',  prizes: [['Декоративна зірка','common'],['Синій камінець','common']] },
  c20:  { price: 20,   chance: .01, name: 'Basic',    prizes: [['Колекційна наліпка','common'],['Мінi-лампа','common']] },
  c50:  { price: 50,   chance: .20, name: 'Rare',     prizes: [['Віртуальний подарунок: Серце','rare'],['Віртуальний подарунок: Зірка','rare']] },
  c100: { price: 100,  chance: .25, name: 'Premium',  prizes: [['Неонова рамка','epic'],['Преміум-декор','epic']] },
  c500: { price: 500,  chance: .30, name: 'Exclusive',prizes: [['Ексклюзивна колекційна статуетка','legendary'],['Золотий бейдж','legendary']] },
  c1000:{ price: 1000, chance: .05, name: 'Froggy Collectible Case', prizes: [['Froggy Card (колекційна картка)','mythic'],['Блакитна жабка','mythic'],['Рожева жабка','mythic'],['Аватар Froggy','mythic'],['Бейдж Froggy VIP','mythic']] },
};
const SPIN = [0, 5, 0, 10, 0, 20, 0, 50, 0, 100]; // сектори колеса (кредити)
const BLOCKS = [ // міцність, нагорода, вага
  { n: 'Земля', hp: 1, r: 0, w: 40 }, { n: 'Камінь', hp: 2, r: 1, w: 30 },
  { n: 'Залізо', hp: 3, r: 4, w: 15 }, { n: 'Золото', hp: 4, r: 12, w: 10 }, { n: 'Діамант', hp: 5, r: 40, w: 5 },
];

const verifyInit = (raw) => {
  const p = new URLSearchParams(raw); const hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const ok = hash && crypto.createHmac('sha256', key).update(str).digest('hex') === hash;
  if (!ok || Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  return JSON.parse(p.get('user'));
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res, next) => {
  let u = null;
  const raw = req.get('X-Init-Data');
  if (raw && BOT_TOKEN) u = verifyInit(raw);
  else if (DEV) u = { id: 1, first_name: 'Dev User', username: 'dev_local' };
  if (!u) return res.status(401).json({ error: 'Невалідна Telegram-авторизація' });
  db.prepare(`INSERT INTO users(id,name,username,photo) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username,photo=excluded.photo`)
    .run(u.id, u.first_name || '', u.username || '', u.photo_url || '');
  req.uid = u.id; next();
});

const user = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const log = (uid, kind, title, delta, item = null) =>
  db.prepare('INSERT INTO history(uid,kind,title,delta,item,ts) VALUES(?,?,?,?,?,?)').run(uid, kind, title, delta, item, Date.now());
const addBal = (uid, d) => db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(d, uid);
// списання атомарне: не дає піти в мінус
const charge = (uid, price) => db.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(price, uid, price).changes === 1;
const tx = f => db.transaction(f);

app.get('/api/me', (req, res) => res.json(user(req.uid)));

app.post('/api/topup', (req, res) => {
  const u = user(req.uid);
  if (Date.now() - u.last_topup < 60000) return res.status(429).json({ error: 'Демо-поповнення раз на хвилину' });
  db.prepare('UPDATE users SET balance=balance+500,last_topup=? WHERE id=?').run(Date.now(), req.uid);
  log(req.uid, 'topup', 'Демо-поповнення', 500);
  res.json(user(req.uid));
});

app.post('/api/case/open', tx((req, res) => {
  const c = CASES[req.body.id];
  if (!c) return res.status(400).json({ error: 'Невідомий кейс' });
  if (!charge(req.uid, c.price)) return res.status(400).json({ error: 'Недостатньо демо-кредитів' });
  const win = rnd() < c.chance;
  const prize = win ? pick(c.prizes) : null;
  db.prepare('UPDATE users SET cases=cases+1 WHERE id=?').run(req.uid);
  log(req.uid, 'case', `Кейс ${c.name}`, -c.price, prize && prize[0]);
  if (prize) db.prepare('INSERT INTO items(uid,name,rarity,ts) VALUES(?,?,?,?)').run(req.uid, prize[0], prize[1], Date.now());
  res.json({ prize, chance: c.chance, balance: user(req.uid).balance });
}));

app.post('/api/spin', tx((req, res) => {
  if (!charge(req.uid, 10)) return res.status(400).json({ error: 'Недостатньо демо-кредитів' });
  const idx = crypto.randomInt(0, SPIN.length), win = SPIN[idx];
  addBal(req.uid, win); db.prepare('UPDATE users SET games=games+1 WHERE id=?').run(req.uid);
  log(req.uid, 'game', 'Lucky Spin', win - 10);
  res.json({ idx, win, sectors: SPIN, balance: user(req.uid).balance });
}));

app.post('/api/miner', tx((req, res) => {
  if (!charge(req.uid, 10)) return res.status(400).json({ error: 'Недостатньо демо-кредитів' });
  let dur = 12, total = 0, steps = [], broken = false;
  const tw = BLOCKS.reduce((s, b) => s + b.w, 0);
  for (let i = 0; i < 15 && !broken; i++) {
    let x = rnd() * tw, b = BLOCKS[0];
    for (const k of BLOCKS) { if ((x -= k.w) < 0) { b = k; break; } }
    dur -= b.hp; const burn = rnd() < 0.03;
    if (dur <= 0 || burn) broken = true; else total += b.r;
    steps.push({ block: b.n, hp: b.hp, reward: broken ? 0 : b.r, dur: Math.max(dur, 0), broken });
  }
  addBal(req.uid, total); db.prepare('UPDATE users SET games=games+1 WHERE id=?').run(req.uid);
  log(req.uid, 'game', 'Miner', total - 10);
  res.json({ steps, total, balance: user(req.uid).balance });
}));

// CRASH: сервер знає точку краху, множник = e^(0.07*t)
const K = 0.07;
const crashState = r => {
  const d = JSON.parse(r.data), m = Math.exp(K * (Date.now() - r.start) / 1000);
  return { d, m, crashed: m >= d.cp };
};
app.post('/api/crash/start', tx((req, res) => {
  if (!charge(req.uid, 10)) return res.status(400).json({ error: 'Недостатньо демо-кредитів' });
  const cp = Math.min(50, Math.max(1, Math.floor(96 / (1 - rnd())) / 100));
  db.prepare('INSERT OR REPLACE INTO rounds VALUES(?,?,?,?)').run(req.uid, 'crash', JSON.stringify({ cp }), Date.now());
  db.prepare('UPDATE users SET games=games+1 WHERE id=?').run(req.uid);
  res.json({ k: K, balance: user(req.uid).balance });
}));
app.get('/api/crash/state', (req, res) => {
  const r = db.prepare("SELECT * FROM rounds WHERE uid=? AND kind='crash'").get(req.uid);
  if (!r) return res.json({ active: false });
  const s = crashState(r);
  if (s.crashed) { db.prepare('DELETE FROM rounds WHERE uid=?').run(req.uid); log(req.uid, 'game', 'Crash (вибух)', -10); return res.json({ crashed: true, at: s.d.cp }); }
  res.json({ active: true, m: s.m });
});
app.post('/api/crash/cashout', tx((req, res) => {
  const r = db.prepare("SELECT * FROM rounds WHERE uid=? AND kind='crash'").get(req.uid);
  if (!r) return res.status(400).json({ error: 'Немає активного раунду' });
  db.prepare('DELETE FROM rounds WHERE uid=?').run(req.uid); // захист від повторного використання
  const s = crashState(r);
  if (s.crashed) { log(req.uid, 'game', 'Crash (вибух)', -10); return res.json({ crashed: true, at: s.d.cp, balance: user(req.uid).balance }); }
  const win = Math.floor(10 * s.m); addBal(req.uid, win);
  log(req.uid, 'game', `Crash x${s.m.toFixed(2)}`, win - 10);
  res.json({ win, m: s.m, balance: user(req.uid).balance });
}));

// DUCK HUNT: сервер обмежує кількість влучань за часом
app.post('/api/duck/start', (req, res) => {
  db.prepare('INSERT OR REPLACE INTO rounds VALUES(?,?,?,?)').run(req.uid, 'duck', '{}', Date.now());
  res.json({ ok: true });
});
app.post('/api/duck/finish', tx((req, res) => {
  const r = db.prepare("SELECT * FROM rounds WHERE uid=? AND kind='duck'").get(req.uid);
  if (!r) return res.status(400).json({ error: 'Немає активного раунду' });
  db.prepare('DELETE FROM rounds WHERE uid=?').run(req.uid);
  const sec = (Date.now() - r.start) / 1000;
  if (sec < 14) return res.status(400).json({ error: 'Раунд ще триває' });
  const hits = Math.max(0, Math.min(parseInt(req.body.hits) || 0, Math.floor(Math.min(sec, 20) * 3)));
  const combo = Math.min(parseInt(req.body.combo) || 0, hits), win = hits * 2 + combo;
  addBal(req.uid, win); db.prepare('UPDATE users SET games=games+1 WHERE id=?').run(req.uid);
  log(req.uid, 'game', `Duck Hunt (${hits} влучань)`, win);
  res.json({ win, hits, balance: user(req.uid).balance });
}));

app.get('/api/history', (req, res) => {
  const k = req.query.kind;
  const rows = k === 'reward'
    ? db.prepare('SELECT * FROM history WHERE uid=? AND item IS NOT NULL ORDER BY id DESC LIMIT 100').all(req.uid)
    : k === 'game' || k === 'case'
      ? db.prepare('SELECT * FROM history WHERE uid=? AND kind=? ORDER BY id DESC LIMIT 100').all(req.uid, k)
      : db.prepare('SELECT * FROM history WHERE uid=? ORDER BY id DESC LIMIT 100').all(req.uid);
  res.json(rows);
});
app.get('/api/items', (req, res) => res.json(db.prepare('SELECT * FROM items WHERE uid=? ORDER BY id DESC').all(req.uid)));
app.get('/api/spins', (req, res) => res.json(db.prepare("SELECT * FROM history WHERE uid=? AND title='Lucky Spin' ORDER BY id DESC LIMIT 10").all(req.uid)));

app.listen(process.env.PORT || 3000, () => console.log('Froggy Casino DEMO on :' + (process.env.PORT || 3000)));
