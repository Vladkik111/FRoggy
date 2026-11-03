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

// Кожне відкриття дає результат: зірки (на баланс) або предмет (в інвентар; можна продати за його ціну).
// I — загальний шанс предмета. Ваги предметів підбираються так, щоб середнє повернення (з продажем) було ≈90%.
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const rarOf = p => p < 100 ? 'common' : p < 500 ? 'rare' : p < 1500 ? 'epic' : p < 5000 ? 'legendary' : 'mythic';
const CASES = {
  c15: { price: 15, name: 'Кейс Бомжа', cover: 'case-bum', I: 0.5, stars: [[3, .15], [8, .25], [12, .15], [15, .10], [16, .15], [17, .10], [18, .07], [23, .03]], items: [["Heart",15],["Gift",25],["Rose",25]] },
  c50: { price: 50, name: 'Кейс Школяра', cover: 'case-kid', I: 0.6, items: [["Cake",50],["Bouquet",50],["Rocket",50],["Champagne",50],["Trophy",100],["Ring",100],["Diamond",100]] },
  c150: { price: 150, name: 'Кейс Будівельника', cover: 'case-builder', I: 0.7, items: [["Trophy",100],["Ring",100],["Diamond",100],["Ice Cream",300],["Popsicle",400]] },
  c350: { price: 350, name: 'Кейс Фермера', cover: 'case-farmer', I: 0.7, items: [["Ice Cream",300],["Popsicle",400],["Instant Ramen",432],["Hypno Lollipop",450],["Torch",470],["Socks",500]] },
  c750: { price: 750, name: 'NFT Кейс', cover: 'case-nft', I: 0.7, items: [["Lantern",517],["Liberty Statue",553],["Snoop Dogg",553],["B-Day Candle",553],['Santa Hat',553],["Light Sword",609],["Sleigh Bell",946],['Hockey Mask',948],['Skull Flower',1027],["Love Candle",1035]] },
  c2000: { price: 2000, name: 'Кейс Багача', cover: 'case-rich', I: 0.7, items: [['Record Player',1091],["Flying Broom",1250],['Hair Dryer',1343],["Trapped Heart",1493],["Heart Locket",1817],["Bling Binky",2331],["Eternal Rose",2367],['Crystal Eagle',2559],["Electric Skull",2687],["Toy Bear",2963],["Bonded Ring",3018],["Signet Ring",3077],["Neko Helmet",3459],['Voodoo Doll',3555],["Swiss Watch",5247],["Low Rider",5531],["Ion Gem",6161],["Mini Oscar",7023],['Golden Hand',10698],["Heroic Helmet",16190],["Durov's Cap",37681],['Hoodie Bear',43852],["Plush Pepe",599627]] },
};
const ITEMP = {}; for (const c of Object.values(CASES)) for (const [n, p] of c.items) ITEMP[n] = p;
const STARS = [[0.5, 0.5], [1, 0.35], [1.5, 0.15]]; // [множник ціни, частка зіркового шансу]
const build = c => {
  const FR = 1e-13, pool = c.items.filter(([, p]) => p < 500000), frog = c.items.filter(([, p]) => p >= 500000);
  const mean = a => { let s = 0, w = 0; for (const [, p] of pool) { const x = Math.pow(p, -a); s += x * p; w += x; } return s / w; };
  const S = c.stars || STARS.map(([m, f]) => [Math.round(c.price * m), f]);
  const star = (1 - c.I) * S.reduce((s, [a, f]) => s + a * f, 0), target = (0.9 * c.price - star) / c.I;
  let lo = 0, hi = 8; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (mean(mid) > target) lo = mid; else hi = mid; }
  const ws = pool.map(([, p]) => Math.pow(p, -hi)), sw = ws.reduce((x, y) => x + y, 0), It = c.I * 100 - frog.length * FR;
  return [...S.map(([a, f]) => ({ w: (1 - c.I) * 100 * f, t: 'stars', amount: a })),
    ...pool.map(([name, p], i) => ({ w: It * ws[i] / sw, t: 'item', name, price: p, rarity: rarOf(p) })),
    ...frog.map(([name, p]) => ({ w: FR, t: 'item', name, price: p, rarity: rarOf(p) }))];
};
for (const c of Object.values(CASES)) c.out = build(c);
const rnd53 = () => Number(BigInt('0x' + crypto.randomBytes(7).toString('hex')) >> 3n) / 2 ** 53;
const SPIN = [0, 0.5, 0, 1, 0, 2, 0, 5, 0, 10]; // множники ставки на секторах колеса
const SPW = [[0, 45], [0.5, 22], [1, 17], [2, 10], [5, 4.5], [10, 1.5]]; // шанс множника, % (середнє повернення ≈85%)
const BLOCKS = [ // міцність, нагорода (у частках ставки: reward*ставка/10), вага
  { n: 'Земля', hp: 1, r: 0, w: 40 }, { n: 'Камінь', hp: 2, r: 1, w: 30 },
  { n: 'Залізо', hp: 3, r: 2, w: 15 }, { n: 'Золото', hp: 4, r: 6, w: 10 }, { n: 'Діамант', hp: 5, r: 22, w: 5 },
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
// Адміни: ID через змінну середовища ADMIN_IDS (через кому). У режимі DEV адміном є тестовий користувач 1.
const ADMIN = new Set((process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean)); if (DEV) ADMIN.add('1');
const getBet = req => { const b = Math.floor(Number(req.body.bet)); return b >= 1 && b <= 1000000 ? b : null; };

app.get('/api/cases', (req, res) => res.json(Object.entries(CASES).map(([id, c]) => ({ id, price: c.price, name: c.name, cover: c.cover, rar: [c.out.find(o => o.t === 'item').rarity, c.out.filter(o => o.t === 'item' && o.w > 1e-6).pop().rarity], outcomes: c.out }))));
app.get('/api/me', (req, res) => res.json({ ...user(req.uid), admin: ADMIN.has(String(req.uid)) }));

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
  let x = rnd53() * 100, o = c.out[0];
  for (const k of c.out) { if ((x -= k.w) < 0) { o = k; break; } }
  db.prepare('UPDATE users SET cases=cases+1 WHERE id=?').run(req.uid);
  let id = null;
  if (o.t === 'stars') { addBal(req.uid, o.amount); log(req.uid, 'case', c.name, o.amount - c.price); }
  else { id = db.prepare('INSERT INTO items(uid,name,rarity,ts) VALUES(?,?,?,?)').run(req.uid, o.name, o.rarity, Date.now()).lastInsertRowid; log(req.uid, 'case', c.name, -c.price, o.name); }
  res.json({ out: o, id, balance: user(req.uid).balance });
}));

app.post('/api/item/sell', tx((req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id=? AND uid=?').get(req.body.id, req.uid);
  if (!it) return res.status(400).json({ error: 'Предмет не знайдено' });
  const p = ITEMP[it.name] || 0;
  db.prepare('DELETE FROM items WHERE id=?').run(it.id); // видалення = захист від подвійного продажу
  addBal(req.uid, p); log(req.uid, 'sell', `Продаж: ${it.name}`, p);
  res.json({ balance: user(req.uid).balance, price: p });
}));

app.post('/api/spin', tx((req, res) => {
  const bet = getBet(req); if (!bet) return res.status(400).json({ error: 'Некоректна ставка' });
  if (!charge(req.uid, bet)) return res.status(400).json({ error: 'Недостатньо кредитів' });
  let x = rnd53() * 100, mult = 0;
  for (const [m, w] of SPW) { if ((x -= w) < 0) { mult = m; break; } }
  const idxs = SPIN.map((v, i) => v === mult ? i : -1).filter(i => i >= 0), idx = pick(idxs), win = Math.floor(bet * mult);
  addBal(req.uid, win); db.prepare('UPDATE users SET games=games+1 WHERE id=?').run(req.uid);
  log(req.uid, 'game', `Lucky Spin x${mult}`, win - bet);
  res.json({ idx, win, mult, sectors: SPIN, balance: user(req.uid).balance });
}));

app.post('/api/miner', tx((req, res) => {
  const bet = getBet(req); if (!bet) return res.status(400).json({ error: 'Некоректна ставка' });
  if (!charge(req.uid, bet)) return res.status(400).json({ error: 'Недостатньо кредитів' });
  let dur = 12, total = 0, steps = [], broken = false;
  const tw = BLOCKS.reduce((s, b) => s + b.w, 0);
  for (let i = 0; i < 15 && !broken; i++) {
    let x = rnd53() * tw, b = BLOCKS[0];
    for (const k of BLOCKS) { if ((x -= k.w) < 0) { b = k; break; } }
    dur -= b.hp; const burn = rnd53() < 0.03;
    if (dur <= 0 || burn) broken = true;
    const reward = broken ? 0 : Math.floor(b.r * bet / 10); total += reward;
    steps.push({ block: b.n, hp: b.hp, reward, dur: Math.max(dur, 0), broken });
  }
  addBal(req.uid, total); db.prepare('UPDATE users SET games=games+1 WHERE id=?').run(req.uid);
  log(req.uid, 'game', 'Miner', total - bet);
  res.json({ steps, total, balance: user(req.uid).balance });
}));

// CRASH: сервер знає точку краху наперед, множник = e^(K*t). Шанс дожити до x: ≈96/x %, тож x20 і більше трапляються рідко.
const K = 0.1, CRASHLOG = [];
const crashState = r => { const d = JSON.parse(r.data), m = Math.exp(K * (Date.now() - r.start) / 1000); return { d, m, crashed: m >= d.cp }; };
const endCrash = d => { CRASHLOG.unshift(d.cp); CRASHLOG.length = Math.min(CRASHLOG.length, 15); };
app.post('/api/crash/start', tx((req, res) => {
  const bet = getBet(req); if (!bet) return res.status(400).json({ error: 'Некоректна ставка' });
  if (!charge(req.uid, bet)) return res.status(400).json({ error: 'Недостатньо кредитів' });
  const cp = Math.min(100, Math.max(1, Math.floor(96 / (1 - rnd53())) / 100));
  db.prepare('INSERT OR REPLACE INTO rounds VALUES(?,?,?,?)').run(req.uid, 'crash', JSON.stringify({ cp, bet }), Date.now());
  db.prepare('UPDATE users SET games=games+1 WHERE id=?').run(req.uid);
  res.json({ k: K, balance: user(req.uid).balance });
}));
app.get('/api/crash/last', (req, res) => res.json(CRASHLOG));
app.get('/api/crash/state', (req, res) => {
  const r = db.prepare("SELECT * FROM rounds WHERE uid=? AND kind='crash'").get(req.uid);
  if (!r) return res.json({ active: false });
  const s = crashState(r);
  if (s.crashed) { db.prepare('DELETE FROM rounds WHERE uid=?').run(req.uid); endCrash(s.d); log(req.uid, 'game', `Crash (x${s.d.cp.toFixed(2)})`, -s.d.bet); return res.json({ crashed: true, at: s.d.cp }); }
  res.json({ active: true, m: s.m });
});
app.post('/api/crash/cashout', tx((req, res) => {
  const r = db.prepare("SELECT * FROM rounds WHERE uid=? AND kind='crash'").get(req.uid);
  if (!r) return res.status(400).json({ error: 'Немає активного раунду' });
  db.prepare('DELETE FROM rounds WHERE uid=?').run(req.uid); // захист від повторного використання
  const s = crashState(r);
  if (s.crashed) { endCrash(s.d); log(req.uid, 'game', `Crash (x${s.d.cp.toFixed(2)})`, -s.d.bet); return res.json({ crashed: true, at: s.d.cp, balance: user(req.uid).balance }); }
  const win = Math.floor(s.d.bet * s.m); addBal(req.uid, win); endCrash(s.d);
  log(req.uid, 'game', `Crash x${s.m.toFixed(2)}`, win - s.d.bet);
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
app.get('/api/items', (req, res) => res.json(db.prepare('SELECT * FROM items WHERE uid=? ORDER BY id DESC').all(req.uid).map(i => ({ ...i, price: ITEMP[i.name] || 0 }))));
app.get('/api/spins', (req, res) => res.json(db.prepare("SELECT * FROM history WHERE uid=? AND title LIKE 'Lucky Spin%' ORDER BY id DESC LIMIT 10").all(req.uid)));


// ---------- Апгрейдер: ставка предметами → ціль (зірки або предмет). Шанс = 90% × ставка / ціль ----------
const upChance = (stake, target) => Math.min(95, Math.max(0.0001, 0.9 * stake / target * 100));
app.get('/api/catalog', (req, res) => res.json(Object.entries(ITEMP).map(([name, price]) => ({ name, price, rarity: rarOf(price) })).sort((a, b) => a.price - b.price)));
app.post('/api/upgrade', tx((req, res) => {
  const ids = [...new Set((Array.isArray(req.body.items) ? req.body.items : []).map(Number))].filter(Number.isInteger).slice(0, 20);
  if (!ids.length) return res.status(400).json({ error: 'Оберіть предмети для апгрейду' });
  const rows = ids.map(id => db.prepare('SELECT * FROM items WHERE id=? AND uid=?').get(id, req.uid));
  if (rows.some(r => !r)) return res.status(400).json({ error: 'Предмет не знайдено' });
  const stake = rows.reduce((a, r) => a + (ITEMP[r.name] || 0), 0);
  if (stake <= 0) return res.status(400).json({ error: 'Предмети без вартості' });
  const t = req.body.target || {}; let T, tItem = null;
  if (t.type === 'stars') { T = Math.floor(Number(t.amount)); if (!(T >= 1 && T <= 10000000)) return res.status(400).json({ error: 'Некоректна сума' }); }
  else if (t.type === 'item' && Object.hasOwn(ITEMP, t.name)) { T = ITEMP[t.name]; tItem = t.name; }
  else return res.status(400).json({ error: 'Оберіть ціль' });
  if (T <= stake) return res.status(400).json({ error: 'Ціль має бути дорожчою за ставку' });
  const chance = upChance(stake, T), pos = rnd53() * 100, win = pos < chance;
  rows.forEach(r => db.prepare('DELETE FROM items WHERE id=?').run(r.id));
  if (win && tItem) db.prepare('INSERT INTO items(uid,name,rarity,ts) VALUES(?,?,?,?)').run(req.uid, tItem, rarOf(T), Date.now());
  if (win && !tItem) addBal(req.uid, T);
  db.prepare('UPDATE users SET games=games+1 WHERE id=?').run(req.uid);
  log(req.uid, 'game', `Upgrader (${win ? 'успіх' : 'невдача'})`, win && !tItem ? T : 0, win && tItem ? tItem : null);
  res.json({ win, pos, chance, stake, target: T, item: tItem, balance: user(req.uid).balance });
}));

// ---------- Адмін-панель (лише для ID з ADMIN_IDS; перевірка завжди на сервері) ----------
app.use('/api/admin', (req, res, next) => ADMIN.has(String(req.uid)) ? next() : res.status(403).json({ error: 'Немає доступу' }));
app.get('/api/admin/stats', (req, res) => {
  const s = db.prepare('SELECT COUNT(*) users, COALESCE(SUM(balance),0) balance, COALESCE(SUM(cases),0) cases, COALESCE(SUM(games),0) games FROM users').get();
  const net = db.prepare("SELECT COALESCE(SUM(delta),0) v FROM history WHERE kind IN ('case','game','sell')").get().v;
  const active = db.prepare('SELECT COUNT(DISTINCT uid) n FROM history WHERE ts>?').get(Date.now() - 864e5).n;
  res.json({ ...s, houseNet: -net, active24: active, items: db.prepare('SELECT COUNT(*) n FROM items').get().n });
});
app.get('/api/admin/users', (req, res) => res.json(db.prepare('SELECT u.id,u.name,u.username,u.balance,u.cases,u.games,(SELECT COUNT(*) FROM items i WHERE i.uid=u.id) items FROM users u ORDER BY u.id DESC LIMIT 100').all()));
app.post('/api/admin/balance', (req, res) => {
  const uid = Number(req.body.uid), amount = Math.floor(Number(req.body.amount)), set = req.body.mode === 'set';
  if (!Number.isInteger(uid) || !Number.isFinite(amount) || Math.abs(amount) > 1e9 || !user(uid)) return res.status(400).json({ error: 'Некоректні дані' });
  if (set) { if (amount < 0) return res.status(400).json({ error: 'Баланс не може бути від’ємним' }); db.prepare('UPDATE users SET balance=? WHERE id=?').run(amount, uid); log(uid, 'admin', 'Корекція балансу (адмін)', 0); }
  else { if (user(uid).balance + amount < 0) return res.status(400).json({ error: 'Баланс не може бути від’ємним' }); addBal(uid, amount); log(uid, 'admin', 'Корекція балансу (адмін)', amount); }
  res.json(user(uid));
});
app.post('/api/admin/reset', tx((req, res) => {
  const uid = Number(req.body.uid); if (!Number.isInteger(uid) || !user(uid)) return res.status(400).json({ error: 'Користувача не знайдено' });
  db.prepare('UPDATE users SET balance=1000,cases=0,games=0,last_topup=0 WHERE id=?').run(uid);
  for (const t of ['items', 'history', 'rounds']) db.prepare(`DELETE FROM ${t} WHERE uid=?`).run(uid);
  res.json(user(uid));
}));

app.listen(process.env.PORT || 3000, () => console.log('Froggy Casino DEMO on :' + (process.env.PORT || 3000)));
