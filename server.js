/* PoolSite Server — Node.js, ohne Abhängigkeiten.
   Statische Dateien + JSON-API + Datei-Datenbank (data/db.json).
   Start:  node server.js   (Port 3000, überschreibbar via PORT) */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = process.env.PORT || 3000;

const PRICES = { post: 0.10, comment: 0.05, like: 0.02, dislike: 0.02 };
const START_CREDITS = 10.00;
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._]{1,29}$/;
const MAX_BODY = 1024 * 1024; // 1 MB (Avatare & komprimierte Beitragsbilder als DataURL)
const MAX_IMAGE = 700 * 1024; // max. Bildgröße nach Client-Kompression

/* ---------- Token-Verteilung (Konstanten) ---------- */
const DAILY_TOKENS = 5000;          // Jahr-1-Emission pro Tag
const NU = 0.10, RHO = 0.2;         // Numéraire & Gate-Schwelle (veröffentlichte Konstante)
const W_TYPE = { like: 1.0, dislike: 0.3, comment: 1.2 };
const LAMBDA_DIM = 0.3;             // abnehmende Ertraege pro Actor->Creator-Paar

/* ---------- Datenbank ---------- */
let db = { users: {}, posts: [], sessions: {}, events: [], meta: null };
function loadDb() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* frische DB */ }
  db.users = db.users || {}; db.posts = db.posts || []; db.sessions = db.sessions || {};
  db.events = db.events || [];
  db.stats = db.stats || {};
  db.friendRequests = db.friendRequests || [];
  db.messages = db.messages || [];
  db.offers = db.offers || [];
  db.trades = db.trades || [];
  if (!db.meta) db.meta = { lastDay: dayStr(Date.now() - 86400000), carryover: 0, totalDistributed: 0 };
}

/* Tages-Statistik: Zähler erhöhen und Nutzer als aktiv markieren */
function stat(field, amount, userKey) {
  const d = dayStr(Date.now());
  const s = db.stats[d] = db.stats[d] || { logins: 0, regs: 0, guests: 0, posts: 0, comments: 0, likes: 0, dislikes: 0, burn: 0, act: {} };
  if (field) s[field] = Math.round(((s[field] || 0) + amount) * 100) / 100;
  if (userKey) s.act[userKey] = 1;
}
function dayStr(t) { return new Date(t).toISOString().slice(0, 10); }
function saveDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
loadDb();

/* ---------- Helfer ---------- */
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function round2(n) { return Math.round(n * 100) / 100; }
function newId(p) { return p + '_' + crypto.randomBytes(6).toString('hex'); }

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  });
  res.end(body);
}

function authKey(req) {
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '');
  return (token && db.sessions[token]) || null;
}

function publicUser(key) {
  const u = db.users[key];
  return u ? { key: key, name: u.name, avatar: u.avatar || null } : { key: key, name: 'Ehemaliger Nutzer', avatar: null };
}

function mePayload(key) {
  const u = db.users[key];
  if (!u) return null;
  return {
    key: key, name: u.name, email: u.email || null, notifyConsent: !!u.notifyConsent,
    createdAt: u.createdAt, avatar: u.avatar || null, guest: !!u.guest,
    credits: u.credits, burn: u.burn, actions: u.actions,
    tokens: u.tokens || 0, startClaimed: !!u.startClaimed
  };
}

function postPayload(p) {
  return {
    id: p.id, text: p.text, image: p.image || null, createdAt: p.createdAt,
    author: publicUser(p.author), authorKey: p.author,
    likes: p.likes || [], dislikes: p.dislikes || [],
    comments: (p.comments || []).map(c => ({
      id: c.id, text: c.text, createdAt: c.createdAt,
      author: publicUser(c.author), authorKey: c.author
    }))
  };
}

function charge(u, action) {
  const price = PRICES[action] || 0;
  if (u.credits + 1e-9 < price) return { ok: false, error: 'Nicht genug Guthaben — diese Aktion kostet ' + price.toFixed(2).replace('.', ',') + ' €.' };
  u.credits = round2(u.credits - price);
  u.burn = round2(u.burn + price);
  u.actions += 1;
  return { ok: true };
}

function newUserRecord(name, passHash, email, guest) {
  return {
    name: name, passHash: passHash, email: email || null, notifyConsent: !!email,
    createdAt: new Date().toISOString(), avatar: null, guest: !!guest,
    credits: 0, burn: 0, actions: 0,
    tokens: 0, startClaimed: false, tokenHistory: []
  };
}

/* ---------- Standing & tägliche Token-Verteilung ---------- */
function alphaHat(u) { return (u.burn / Math.max(u.actions, 1)) / NU; }
function lam(x) { return x / (1 + x); }

function logEvent(type, actorKey, creatorKey) {
  if (actorKey === creatorKey) return; // Selbst-Engagement zählt nicht
  db.events.push({ d: dayStr(Date.now()), t: type, a: actorKey, c: creatorKey });
}

function dayWeights(day) {
  const weights = {}; const pairCount = {};
  for (const e of db.events) {
    if (e.d !== day) continue;
    const actor = db.users[e.a];
    if (!actor) continue;
    const a = alphaHat(actor);
    if (actor.actions === 0 || a < RHO) continue; // Gate geschlossen -> Gewicht 0
    const pk = e.a + '>' + e.c;
    pairCount[pk] = (pairCount[pk] || 0) + 1;
    const w = (W_TYPE[e.t] || 0) * (1 / (1 + LAMBDA_DIM * Math.max(0, pairCount[pk] - 1))) * lam(a);
    weights[e.c] = (weights[e.c] || 0) + w;
  }
  return weights;
}

function distribute() {
  const today = dayStr(Date.now());
  let changed = false;
  let guard = 0;
  while (guard++ < 400) {
    const next = dayStr(new Date(db.meta.lastDay + 'T00:00:00Z').getTime() + 86400000);
    if (next >= today) break; // erst verteilen, wenn der Tag abgeschlossen ist
    // 'next' ist ein abgeschlossener Tag (< heute): verteilen
    const pool = DAILY_TOKENS + db.meta.carryover;
    const weights = dayWeights(next);
    let total = 0;
    for (const k of Object.keys(weights)) total += weights[k];
    if (total > 0) {
      for (const k of Object.keys(weights)) {
        const u = db.users[k];
        if (!u) continue;
        const amt = Math.round(pool * weights[k] / total * 100) / 100;
        u.tokens = Math.round(((u.tokens || 0) + amt) * 100) / 100;
        u.tokenHistory = u.tokenHistory || [];
        u.tokenHistory.push({ day: next, amount: amt });
      }
      db.meta.totalDistributed = Math.round((db.meta.totalDistributed + pool) * 100) / 100;
      db.meta.carryover = 0;
    } else {
      db.meta.carryover = pool; // kein anspruchsberechtigtes Gewicht -> Übertrag
    }
    db.meta.lastDay = next;
    changed = true;
  }
  // alte Events (> 40 Tage) und alte Tagesstatistiken (> 90 Tage) aufräumen
  const cutoff = dayStr(Date.now() - 40 * 86400000);
  const before = db.events.length;
  db.events = db.events.filter(e => e.d >= cutoff);
  const statCutoff = dayStr(Date.now() - 90 * 86400000);
  for (const d of Object.keys(db.stats)) if (d < statCutoff) delete db.stats[d];
  if (changed || db.events.length !== before) saveDb();
}

/* ---------- API ---------- */
function handleApi(req, res, pathname, body) {
  const key = authKey(req);
  const me = key ? db.users[key] : null;

  // Öffentlich
  if (pathname === '/api/health') return json(res, 200, { ok: true, name: 'PoolSite', mode: 'server' });

  if (pathname === '/api/register' && req.method === 'POST') {
    const name = String(body.username || '').trim();
    const pass = String(body.password || '');
    const email = String(body.email || '').trim();
    if (!USER_RE.test(name)) return json(res, 400, { error: 'Nutzername: 2–30 Zeichen, beginnt mit Buchstabe/Zahl; erlaubt sind Buchstaben, Zahlen, Punkt, Unterstrich.' });
    if (pass.length < 4) return json(res, 400, { error: 'Das Passwort muss mindestens 4 Zeichen haben.' });
    const k = name.toLowerCase();
    if (db.users[k]) return json(res, 409, { error: 'Dieser Nutzername ist bereits vergeben.' });
    db.users[k] = newUserRecord(name, sha(k + ':' + pass), email, false);
    const token = newId('tok');
    db.sessions[token] = k;
    stat('regs', 1, k);
    saveDb();
    return json(res, 200, { token: token, me: mePayload(k) });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const k = String(body.username || '').trim().toLowerCase();
    const pass = String(body.password || '');
    const u = db.users[k];
    if (!u || u.guest || u.passHash !== sha(k + ':' + pass)) {
      return json(res, 401, { error: 'Nutzername oder Passwort ist falsch.' });
    }
    const token = newId('tok');
    db.sessions[token] = k;
    stat('logins', 1, k);
    saveDb();
    return json(res, 200, { token: token, me: mePayload(k) });
  }

  if (pathname === '/api/guest' && req.method === 'POST') {
    const k = newId('guest');
    db.users[k] = newUserRecord('Gast', null, null, true);
    const token = newId('tok');
    db.sessions[token] = k;
    stat('guests', 1, k);
    saveDb();
    return json(res, 200, { token: token, me: mePayload(k) });
  }

  if (pathname === '/api/stats' && req.method === 'GET') {
    distribute();
    const daily = [];
    for (let i = 13; i >= 0; i--) {
      const d = dayStr(Date.now() - i * 86400000);
      const s = db.stats[d] || {};
      daily.push({
        day: d, logins: s.logins || 0, regs: s.regs || 0, guests: s.guests || 0,
        posts: s.posts || 0, comments: s.comments || 0, likes: s.likes || 0,
        dislikes: s.dislikes || 0, burn: s.burn || 0,
        actives: s.act ? Object.keys(s.act).length : 0
      });
    }
    let users = 0, guests = 0, burn = 0, credits = 0, claimed = 0;
    for (const k of Object.keys(db.users)) {
      const u = db.users[k];
      if (u.guest) guests++; else users++;
      burn += u.burn || 0; credits += u.credits || 0;
      if (u.startClaimed) claimed++;
    }
    let comments = 0, likes = 0, dislikes = 0;
    db.posts.forEach(p => {
      comments += (p.comments || []).length;
      likes += (p.likes || []).length;
      dislikes += (p.dislikes || []).length;
    });
    const todayS = db.stats[dayStr(Date.now())];
    return json(res, 200, {
      totals: {
        users: users, guests: guests, posts: db.posts.length,
        comments: comments, likes: likes, dislikes: dislikes,
        burn: round2(burn), credits: round2(credits), claimed: claimed,
        tokensDistributed: db.meta.totalDistributed, carryover: db.meta.carryover,
        activesToday: todayS && todayS.act ? Object.keys(todayS.act).length : 0
      },
      daily: daily
    });
  }

  if (pathname === '/api/posts' && req.method === 'GET') {
    const posts = db.posts.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return json(res, 200, { posts: posts.map(postPayload) });
  }

  // Ab hier: Anmeldung nötig
  if (!me) return json(res, 401, { error: 'Nicht angemeldet.' });

  if (pathname === '/api/me' && req.method === 'GET') return json(res, 200, { me: mePayload(key) });

  if (pathname === '/api/logout' && req.method === 'POST') {
    for (const t of Object.keys(db.sessions)) if (db.sessions[t] === key) delete db.sessions[t];
    saveDb();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && req.method === 'DELETE') {
    db.posts = db.posts.filter(p => p.author !== key);
    db.posts.forEach(p => {
      p.likes = (p.likes || []).filter(x => x !== key);
      p.dislikes = (p.dislikes || []).filter(x => x !== key);
      p.comments = (p.comments || []).filter(c => c.author !== key);
    });
    delete db.users[key];
    for (const t of Object.keys(db.sessions)) if (db.sessions[t] === key) delete db.sessions[t];
    db.friendRequests = db.friendRequests.filter(r => r.from !== key && r.to !== key);
    db.messages = db.messages.filter(m => m.from !== key && m.to !== key);
    db.offers = db.offers.filter(o => o.seller !== key);
    for (const k of Object.keys(db.users)) {
      const u = db.users[k];
      if (u.friends) u.friends = u.friends.filter(f => f !== key);
      if (u.lastRead) delete u.lastRead[key];
    }
    saveDb();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/upgrade' && req.method === 'POST') {
    if (!me.guest) return json(res, 400, { error: 'Nur Gast-Konten können umgewandelt werden.' });
    const name = String(body.username || '').trim();
    const pass = String(body.password || '');
    const email = String(body.email || '').trim();
    if (!USER_RE.test(name)) return json(res, 400, { error: 'Nutzername: 2–30 Zeichen, beginnt mit Buchstabe/Zahl; erlaubt sind Buchstaben, Zahlen, Punkt, Unterstrich.' });
    if (pass.length < 4) return json(res, 400, { error: 'Das Passwort muss mindestens 4 Zeichen haben.' });
    const nk = name.toLowerCase();
    if (db.users[nk]) return json(res, 409, { error: 'Dieser Nutzername ist bereits vergeben.' });
    db.users[nk] = Object.assign({}, me, {
      name: name, passHash: sha(nk + ':' + pass), email: email || null,
      notifyConsent: !!email, guest: false
    });
    delete db.users[key];
    db.posts.forEach(p => {
      if (p.author === key) p.author = nk;
      p.likes = (p.likes || []).map(x => x === key ? nk : x);
      p.dislikes = (p.dislikes || []).map(x => x === key ? nk : x);
      (p.comments || []).forEach(c => { if (c.author === key) c.author = nk; });
    });
    for (const t of Object.keys(db.sessions)) if (db.sessions[t] === key) db.sessions[t] = nk;
    db.friendRequests.forEach(r => { if (r.from === key) r.from = nk; if (r.to === key) r.to = nk; });
    db.messages.forEach(m => { if (m.from === key) m.from = nk; if (m.to === key) m.to = nk; });
    db.offers.forEach(o => { if (o.seller === key) o.seller = nk; });
    db.trades.forEach(t => { if (t.buyer === key) t.buyer = nk; if (t.seller === key) t.seller = nk; });
    for (const k of Object.keys(db.users)) {
      const u = db.users[k];
      if (u.friends) u.friends = u.friends.map(f => f === key ? nk : f);
      if (u.lastRead && u.lastRead[key] !== undefined) { u.lastRead[nk] = u.lastRead[key]; delete u.lastRead[key]; }
    }
    saveDb();
    return json(res, 200, { me: mePayload(nk) });
  }

  if (pathname === '/api/avatar' && req.method === 'POST') {
    const d = String(body.dataUrl || '');
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(d) || d.length > 200000) {
      return json(res, 400, { error: 'Ungültiges oder zu großes Bild.' });
    }
    me.avatar = d;
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  if (pathname === '/api/claim-start' && req.method === 'POST') {
    if (me.startClaimed) return json(res, 400, { error: 'Du hast dein Startguthaben bereits abgeholt.' });
    me.startClaimed = true;
    me.credits = round2(me.credits + START_CREDITS);
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  if (pathname === '/api/wallet' && req.method === 'GET') {
    distribute();
    const today = dayStr(Date.now());
    const weights = dayWeights(today);
    let networkWeight = 0;
    for (const k of Object.keys(weights)) networkWeight += weights[k];
    const myWeight = weights[key] || 0;
    const pool = DAILY_TOKENS + db.meta.carryover;
    const history = (me.tokenHistory || []).slice(-30);
    const yesterday = dayStr(Date.now() - 86400000);
    const yEntry = (me.tokenHistory || []).filter(h => h.day === yesterday);
    const nextMidnight = new Date();
    nextMidnight.setUTCHours(24, 0, 0, 0);
    const lastPrice = db.trades.length ? db.trades[db.trades.length - 1].pricePerToken : null;
    return json(res, 200, {
      me: mePayload(key),
      wallet: {
        tokens: me.tokens || 0,
        history: history,
        yesterday: yEntry.length ? yEntry[0].amount : 0,
        todayWeight: Math.round(myWeight * 1000) / 1000,
        networkWeight: Math.round(networkWeight * 1000) / 1000,
        projected: networkWeight > 0 ? Math.round(pool * myWeight / networkWeight * 100) / 100 : 0,
        poolToday: pool,
        carryover: db.meta.carryover,
        totalDistributed: db.meta.totalDistributed,
        nextDistribution: nextMidnight.toISOString(),
        lastPrice: lastPrice,
        marketCap: lastPrice ? round2(db.meta.totalDistributed * lastPrice) : null
      }
    });
  }

  /* ---------- Markt: Token-Handel zwischen Nutzern ---------- */
  const TRADE_FEE = 0.04; // 4 % Plattformgebühr (2 % Treasury + 1 % Pool + 1 % Referral)

  if (pathname === '/api/market' && req.method === 'GET') {
    const offers = db.offers.slice()
      .sort((a, b) => a.pricePerToken - b.pricePerToken)
      .map(o => ({
        id: o.id, amount: o.amount, pricePerToken: o.pricePerToken,
        total: round2(o.amount * o.pricePerToken),
        seller: publicUser(o.seller), mine: o.seller === key, createdAt: o.createdAt
      }));
    const trades = db.trades.slice(-30).reverse().map(t => ({
      amount: t.amount, pricePerToken: t.pricePerToken, total: t.total, at: t.at,
      buyer: publicUser(t.buyer).name, seller: publicUser(t.seller).name
    }));
    const lastPrice = db.trades.length ? db.trades[db.trades.length - 1].pricePerToken : null;
    return json(res, 200, { offers: offers, trades: trades, lastPrice: lastPrice, feePct: TRADE_FEE * 100, me: mePayload(key) });
  }

  if (pathname === '/api/market/offers' && req.method === 'POST') {
    const amount = Math.round((+body.amount || 0) * 100) / 100;
    const price = Math.round((+body.pricePerToken || 0) * 10000) / 10000;
    if (!(amount >= 1)) return json(res, 400, { error: 'Mindestmenge: 1 PST.' });
    if (!(price >= 0.0001 && price <= 1000)) return json(res, 400, { error: 'Preis pro Token: 0,0001 € bis 1.000 €.' });
    if ((me.tokens || 0) + 1e-9 < amount) return json(res, 400, { error: 'Nicht genug Token — du hast ' + (me.tokens || 0) + ' PST.' });
    me.tokens = round2(me.tokens - amount); // Treuhand: Token sind ab jetzt im Angebot gebunden
    db.offers.push({ id: newId('off'), seller: key, amount: amount, pricePerToken: price, createdAt: new Date().toISOString() });
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  const mOffer = pathname.match(/^\/api\/market\/offers\/([\w]+)$/);
  if (mOffer && req.method === 'DELETE') {
    const idx = db.offers.findIndex(o => o.id === mOffer[1] && o.seller === key);
    if (idx < 0) return json(res, 404, { error: 'Angebot nicht gefunden.' });
    me.tokens = round2((me.tokens || 0) + db.offers[idx].amount); // Treuhand zurück
    db.offers.splice(idx, 1);
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  const mBuy = pathname.match(/^\/api\/market\/offers\/([\w]+)\/buy$/);
  if (mBuy && req.method === 'POST') {
    const offer = db.offers.find(o => o.id === mBuy[1]);
    if (!offer) return json(res, 404, { error: 'Angebot nicht mehr verfügbar.' });
    if (offer.seller === key) return json(res, 400, { error: 'Du kannst dein eigenes Angebot nicht kaufen.' });
    const amt = body.amount ? Math.round((+body.amount) * 100) / 100 : offer.amount;
    if (!(amt > 0) || amt - offer.amount > 1e-9) return json(res, 400, { error: 'Ungültige Menge (verfügbar: ' + offer.amount + ' PST).' });
    const total = round2(amt * offer.pricePerToken);
    if (total < 0.01) return json(res, 400, { error: 'Kaufbetrag zu klein (min. 0,01 €).' });
    if (me.credits + 1e-9 < total) return json(res, 402, { error: 'Nicht genug Guthaben — Kauf kostet ' + total.toFixed(2).replace('.', ',') + ' €.' });

    const fee = round2(total * TRADE_FEE);
    const proceeds = round2(total - fee);
    me.credits = round2(me.credits - total);
    me.tokens = round2((me.tokens || 0) + amt);
    const seller = db.users[offer.seller];
    if (seller) {
      seller.credits = round2(seller.credits + proceeds);
      seller.burn = round2(seller.burn + fee); // Gebühr ist unwiderruflich weg -> zählt ins Commitment B
    }
    offer.amount = round2(offer.amount - amt);
    if (offer.amount < 0.01) db.offers = db.offers.filter(o => o.id !== offer.id);
    db.trades.push({ id: newId('tr'), buyer: key, seller: offer.seller, amount: amt, pricePerToken: offer.pricePerToken, total: total, at: new Date().toISOString() });
    if (db.trades.length > 500) db.trades = db.trades.slice(-500);
    stat(null, 0, key);
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  /* ---------- Freunde & Chat ---------- */
  function ensureSocial(u) { u.friends = u.friends || []; u.lastRead = u.lastRead || {}; }
  function relationTo(k) {
    ensureSocial(me);
    if (me.friends.indexOf(k) >= 0) return 'friend';
    if (db.friendRequests.some(r => r.from === key && r.to === k)) return 'out';
    if (db.friendRequests.some(r => r.from === k && r.to === key)) return 'in';
    return 'none';
  }

  if (pathname === '/api/users' && req.method === 'GET') {
    const qs = new URLSearchParams((req.url.split('?')[1] || ''));
    const q = String(qs.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return json(res, 200, { users: [] });
    const out = [];
    for (const k of Object.keys(db.users)) {
      if (k === key) continue;
      const u = db.users[k];
      if (u.name.toLowerCase().indexOf(q) < 0) continue;
      out.push({ key: k, name: u.name, avatar: u.avatar || null, guest: !!u.guest, relation: relationTo(k) });
      if (out.length >= 20) break;
    }
    return json(res, 200, { users: out });
  }

  if (pathname === '/api/friends' && req.method === 'GET') {
    ensureSocial(me);
    const friends = me.friends.filter(k => db.users[k]).map(k => {
      const last = me.lastRead[k] || '1970';
      const unread = db.messages.filter(m => m.from === k && m.to === key && m.at > last).length;
      return { key: k, name: db.users[k].name, avatar: db.users[k].avatar || null, unread: unread };
    });
    const requestsIn = db.friendRequests.filter(r => r.to === key && db.users[r.from])
      .map(r => ({ key: r.from, name: db.users[r.from].name, avatar: db.users[r.from].avatar || null }));
    const requestsOut = db.friendRequests.filter(r => r.from === key && db.users[r.to])
      .map(r => ({ key: r.to, name: db.users[r.to].name, avatar: db.users[r.to].avatar || null }));
    return json(res, 200, { friends: friends, requestsIn: requestsIn, requestsOut: requestsOut });
  }

  if (pathname === '/api/friends/request' && req.method === 'POST') {
    const to = String(body.to || '');
    const target = db.users[to];
    ensureSocial(me);
    if (!target || to === key) return json(res, 400, { error: 'Nutzer nicht gefunden.' });
    if (me.friends.indexOf(to) >= 0) return json(res, 400, { error: 'Ihr seid bereits befreundet.' });
    if (db.friendRequests.some(r => r.from === key && r.to === to)) return json(res, 400, { error: 'Anfrage bereits gesendet.' });
    // Gegenanfrage vorhanden? Dann direkt Freunde werden.
    const reverse = db.friendRequests.findIndex(r => r.from === to && r.to === key);
    if (reverse >= 0) {
      db.friendRequests.splice(reverse, 1);
      ensureSocial(target);
      me.friends.push(to); target.friends.push(key);
      saveDb();
      return json(res, 200, { ok: true, becameFriends: true });
    }
    db.friendRequests.push({ from: key, to: to, at: new Date().toISOString() });
    saveDb();
    return json(res, 200, { ok: true, becameFriends: false });
  }

  if (pathname === '/api/friends/accept' && req.method === 'POST') {
    const from = String(body.from || '');
    const idx = db.friendRequests.findIndex(r => r.from === from && r.to === key);
    if (idx < 0) return json(res, 404, { error: 'Anfrage nicht gefunden.' });
    db.friendRequests.splice(idx, 1);
    const other = db.users[from];
    if (other) {
      ensureSocial(me); ensureSocial(other);
      if (me.friends.indexOf(from) < 0) me.friends.push(from);
      if (other.friends.indexOf(key) < 0) other.friends.push(key);
    }
    saveDb();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/friends/decline' && req.method === 'POST') {
    const from = String(body.from || '');
    db.friendRequests = db.friendRequests.filter(r => !(r.from === from && r.to === key));
    saveDb();
    return json(res, 200, { ok: true });
  }

  const mUnfriend = pathname.match(/^\/api\/friends\/([\w]+)$/);
  if (mUnfriend && req.method === 'DELETE') {
    const other = db.users[mUnfriend[1]];
    ensureSocial(me);
    me.friends = me.friends.filter(k => k !== mUnfriend[1]);
    if (other) { ensureSocial(other); other.friends = other.friends.filter(k => k !== key); }
    saveDb();
    return json(res, 200, { ok: true });
  }

  const mChat = pathname.match(/^\/api\/chat\/([\w]+)$/);
  if (mChat && req.method === 'GET') {
    const other = mChat[1];
    ensureSocial(me);
    if (me.friends.indexOf(other) < 0 || !db.users[other]) return json(res, 403, { error: 'Ihr seid nicht befreundet.' });
    const msgs = db.messages
      .filter(m => (m.from === key && m.to === other) || (m.from === other && m.to === key))
      .sort((a, b) => a.at < b.at ? -1 : 1)
      .slice(-200)
      .map(m => ({ id: m.id, from: m.from, text: m.text, at: m.at }));
    me.lastRead[other] = new Date().toISOString();
    saveDb();
    return json(res, 200, {
      friend: { key: other, name: db.users[other].name, avatar: db.users[other].avatar || null },
      messages: msgs
    });
  }

  if (mChat && req.method === 'POST') {
    const other = mChat[1];
    ensureSocial(me);
    if (me.friends.indexOf(other) < 0 || !db.users[other]) return json(res, 403, { error: 'Ihr seid nicht befreundet.' });
    const text = String(body.text || '').trim().slice(0, 1000);
    if (!text) return json(res, 400, { error: 'Leere Nachricht.' });
    db.messages.push({ id: newId('m'), from: key, to: other, text: text, at: new Date().toISOString() });
    stat(null, 0, key);
    saveDb();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/posts' && req.method === 'POST') {
    const text = String(body.text || '').trim().slice(0, 500);
    let image = null;
    if (body.image) {
      const d = String(body.image);
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(d)) return json(res, 400, { error: 'Ungültiges Bildformat.' });
      if (d.length > MAX_IMAGE) return json(res, 400, { error: 'Bild zu groß (max. ~500 KB nach Kompression).' });
      image = d;
    }
    if (!text && !image) return json(res, 400, { error: 'Schreib etwas oder füge ein Bild hinzu.' });
    const pay = charge(me, 'post');
    if (!pay.ok) return json(res, 402, { error: pay.error });
    db.posts.push({ id: newId('post'), author: key, text: text, image: image, createdAt: new Date().toISOString(), likes: [], dislikes: [], comments: [] });
    stat('posts', 1, key);
    stat('burn', PRICES.post);
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  const mReact = pathname.match(/^\/api\/posts\/([\w]+)\/react$/);
  if (mReact && req.method === 'POST') {
    const p = db.posts.find(x => x.id === mReact[1]);
    if (!p) return json(res, 404, { error: 'Beitrag nicht gefunden.' });
    const kind = body.kind === 'dislikes' ? 'dislikes' : 'likes';
    p.likes = p.likes || []; p.dislikes = p.dislikes || [];
    const list = p[kind];
    const other = kind === 'likes' ? p.dislikes : p.likes;
    const i = list.indexOf(key);
    if (i >= 0) {
      list.splice(i, 1); // Zurücknehmen gratis, Burn bleibt
    } else {
      const pay = charge(me, kind === 'likes' ? 'like' : 'dislike');
      if (!pay.ok) return json(res, 402, { error: pay.error });
      const j = other.indexOf(key);
      if (j >= 0) other.splice(j, 1);
      list.push(key);
      logEvent(kind === 'likes' ? 'like' : 'dislike', key, p.author);
      stat(kind, 1, key);
      stat('burn', kind === 'likes' ? PRICES.like : PRICES.dislike);
    }
    saveDb();
    return json(res, 200, { me: mePayload(key), post: postPayload(p) });
  }

  const mComment = pathname.match(/^\/api\/posts\/([\w]+)\/comments$/);
  if (mComment && req.method === 'POST') {
    const p = db.posts.find(x => x.id === mComment[1]);
    if (!p) return json(res, 404, { error: 'Beitrag nicht gefunden.' });
    const text = String(body.text || '').trim().slice(0, 300);
    if (!text) return json(res, 400, { error: 'Leerer Kommentar.' });
    const pay = charge(me, 'comment');
    if (!pay.ok) return json(res, 402, { error: pay.error });
    p.comments = p.comments || [];
    p.comments.push({ id: newId('c'), author: key, text: text, createdAt: new Date().toISOString() });
    logEvent('comment', key, p.author);
    stat('comments', 1, key);
    stat('burn', PRICES.comment);
    saveDb();
    return json(res, 200, { me: mePayload(key), post: postPayload(p) });
  }

  const mDelC = pathname.match(/^\/api\/posts\/([\w]+)\/comments\/([\w]+)$/);
  if (mDelC && req.method === 'DELETE') {
    const p = db.posts.find(x => x.id === mDelC[1]);
    if (!p) return json(res, 404, { error: 'Beitrag nicht gefunden.' });
    p.comments = (p.comments || []).filter(c => !(c.id === mDelC[2] && c.author === key));
    saveDb();
    return json(res, 200, { post: postPayload(p) });
  }

  const mDelP = pathname.match(/^\/api\/posts\/([\w]+)$/);
  if (mDelP && req.method === 'DELETE') {
    const p = db.posts.find(x => x.id === mDelP[1]);
    if (!p) return json(res, 404, { error: 'Beitrag nicht gefunden.' });
    if (p.author !== key) return json(res, 403, { error: 'Nur eigene Beiträge können gelöscht werden.' });
    db.posts = db.posts.filter(x => x.id !== p.id);
    saveDb();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Unbekannter API-Endpunkt.' });
}

/* ---------- Statische Dateien ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || rel.startsWith('/data') || rel === '/server.js' || rel.startsWith('/.git')) {
    res.writeHead(403); return res.end('Verboten');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ---------- Server ---------- */
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);

  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (pathname.startsWith('/api/')) {
    let raw = '';
    let tooBig = false;
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return;
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'Ungültiges JSON.' }); } }
      try { handleApi(req, res, pathname, body); }
      catch (e) { console.error(e); json(res, 500, { error: 'Serverfehler.' }); }
    });
    return;
  }

  serveStatic(res, pathname);
});

distribute();                                // ausstehende Tage beim Start verarbeiten
setInterval(distribute, 60 * 1000);          // und danach jede Minute prüfen (00:00 UTC)

server.listen(PORT, '0.0.0.0', () => {
  console.log('PoolSite-Server läuft: http://localhost:' + PORT);
});
