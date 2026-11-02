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

// Кожне відкриття завжди дає результат: зірки (множник від ціни) або предмет. Предмети: шанс обернено пропорційний ціні.
const OUT = [[0.5, 7], [0.8, 27], [0.9, 40], [1, 13], [1.2, 8], [1.5, 4]]; // [множник ціни, шанс %]; ≥ ціни: 25%; предмети: решта 1%
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const rarOf = p => p < 100 ? 'common' : p < 500 ? 'rare' : p < 1500 ? 'epic' : p < 5000 ? 'legendary' : 'mythic';
const CASES = {
  c15: { price: 15, name: 'Red Rose', items: [['Ribbon Heart',15],['Red Gift Box',25],['Red Rose',25]] },
  c50: { price: 50, name: 'Champagne Pop', items: [['Party Cake',50],['Flower Bouquet',50],['Space Rocket',50],['Champagne Pop',50]] },
  c100: { price: 100, name: 'Blue Diamond', items: [['Gold Trophy',100],['Diamond Ring',100],['Blue Diamond',100]] },
  c250: { price: 250, name: 'Choco Popsicle', items: [['Cream Cone',300],['Choco Popsicle',400]] },
  c400: { price: 400, name: 'Navy Socks', items: [['Noodle Box',432],['Swirl Lollipop',450],['Glow Torch',470],['Navy Socks',500]] },
  c750: { price: 750, name: 'Laser Blade', items: [['Copper Lantern',517],['Jade Statue',553],['Cool Dog',553],['Birthday Sign',553],['Santa Hat',553],['Laser Blade',609]] },
  c1000: { price: 1000, name: 'Web Heart', items: [['Golden Bell',946],['Hockey Mask',948],['Skull Flower',1027],['Heart Candle',1035],['Record Player',1091],['Magic Broom',1250],['Hair Dryer',1343],['Web Heart',1493]] },
  c4500: { price: 4500, name: 'Voodoo Doll', items: [['Golden Locket',1817],['Golden Pacifier',2331],['Rose Dome',2367],['Crystal Eagle',2559],['Violet Skull',2687],['Pink Bear',2963],['Ring Box',3018],['Gold Signet',3077],['Neon Helmet',3459],['Voodoo Doll',3555]] },
  c10000: { price: 10000, name: 'Heart Frog', items: [['Gold Watch',5247],['Blue Lowrider',5531],['Ice Crystals',6161],['Gold Statuette',7023],['Golden Hand',10698],['Spartan Helmet',16190],['Black Cap',37681],['Hoodie Bear',43852],['Heart Frog',599627]] },
};
const outcomes = c => {
  const FR = 1e-13, ws = c.items.map(([, p]) => p >= 500000 ? 0 : 1 / p), sum = ws.reduce((a, b) => a + b, 0);
  return [...OUT.map(([m, w]) => ({ w, t: 'stars', amount: Math.round(c.price * m) })),
    ...c.items.map(([name, p], i) => ({ w: p >= 500000 ? FR : (1 - FR) * ws[i] / sum, t: 'item', name, rarity: rarOf(p) }))];
};
const rnd53 = () => Number(BigInt('0x' + crypto.randomBytes(7).toString('hex')) >> 3n) / 2 ** 53;
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

app.get('/api/cases', (req, res) => res.json(Object.entries(CASES).map(([id, c]) => { const last = c.items[c.items.length - 1]; return { id, price: c.price, name: c.name, rar: [rarOf(c.items[0][1]), rarOf(last[1])], icon: slug(last[0]), outcomes: outcomes(c) }; })));
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
  if (!charge(req.uid, c.price)) return res.status(400).json({ error: 'Недостатньо кредитів' });
  const os = outcomes(c); let x = rnd53() * 100, o = os[0];
  for (const k of os) { if ((x -= k.w) < 0) { o = k; break; } }
  db.prepare('UPDATE users SET cases=cases+1 WHERE id=?').run(req.uid);
  if (o.t === 'stars') { addBal(req.uid, o.amount); log(req.uid, 'case', `Кейс ${c.name}`, o.amount - c.price); }
  else { db.prepare('INSERT INTO items(uid,name,rarity,ts) VALUES(?,?,?,?)').run(req.uid, o.name, o.rarity, Date.now()); log(req.uid, 'case', `Кейс ${c.name}`, -c.price, o.name); }
  res.json({ out: o, balance: user(req.uid).balance });
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
