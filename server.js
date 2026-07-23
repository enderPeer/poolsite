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
const MAX_BODY = 300 * 1024; // 300 KB (Avatare als DataURL)

/* ---------- Datenbank ---------- */
let db = { users: {}, posts: [], sessions: {} };
function loadDb() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* frische DB */ }
  db.users = db.users || {}; db.posts = db.posts || []; db.sessions = db.sessions || {};
}
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
    credits: u.credits, burn: u.burn, actions: u.actions
  };
}

function postPayload(p) {
  return {
    id: p.id, text: p.text, createdAt: p.createdAt,
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
    credits: START_CREDITS, burn: 0, actions: 0
  };
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
    saveDb();
    return json(res, 200, { token: token, me: mePayload(k) });
  }

  if (pathname === '/api/guest' && req.method === 'POST') {
    const k = newId('guest');
    db.users[k] = newUserRecord('Gast', null, null, true);
    const token = newId('tok');
    db.sessions[token] = k;
    saveDb();
    return json(res, 200, { token: token, me: mePayload(k) });
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

  if (pathname === '/api/topup' && req.method === 'POST') {
    me.credits = round2(me.credits + 10);
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  if (pathname === '/api/posts' && req.method === 'POST') {
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) return json(res, 400, { error: 'Schreib erst etwas, bevor du postest.' });
    const pay = charge(me, 'post');
    if (!pay.ok) return json(res, 402, { error: pay.error });
    db.posts.push({ id: newId('post'), author: key, text: text, createdAt: new Date().toISOString(), likes: [], dislikes: [], comments: [] });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log('PoolSite-Server läuft: http://localhost:' + PORT);
});
