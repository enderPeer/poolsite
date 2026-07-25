/* PoolSite Server — Node.js, ohne Abhängigkeiten.
   Statische Dateien + JSON-API + Datei-Datenbank (data/db.json).
   Start:  node server.js   (Port 3000, überschreibbar via PORT) */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

const store = require('./store');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');       // Alt-Format (nur noch für die einmalige Migration)
const SQLITE_FILE = path.join(DATA_DIR, 'poolsite.db');
const PORT = process.env.PORT || 3000;

const PRICES = { post: 0.10, comment: 0.05, like: 0.02, dislike: 0.02 };
const START_CREDITS = 10.00;

/* sBTC — simuliertes Demo-Bitcoin (kein echtes Geld, keine echte Blockchain) */
const SBTC_RATE = 100000;                 // 1 sBTC = 100.000 EUR-Credits (fester Demo-Kurs)
const FAUCET_AMOUNT = 0.0002;             // täglich abholbar (= 20 € beim Burn)
const DEAD_ADDRESS = 'sbtc1qdead000000000000000000000000000burn';
function r8(n) { return Math.round(n * 1e8) / 1e8; }
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._]{1,29}$/;
const MAX_BODY = 4 * 1024 * 1024; // 4 MB (komprimierte Videos als DataURL beim Upload)
const MAX_IMAGE = 700 * 1024;     // max. Bildgröße nach Client-Kompression
const MAX_VIDEO = 3 * 1024 * 1024; // max. Video-DataURL (~2 MB binär) nach Client-Kompression
const MEDIA_DIR = path.join(DATA_DIR, 'media');

/* ---------- Token-Verteilung (Konstanten) ---------- */
const DAILY_TOKENS = 5000;          // Jahr-1-Emission pro Tag
const NU = 0.10, RHO = 0.2;         // Numéraire & Gate-Schwelle (veröffentlichte Konstante)
const W_TYPE = { like: 1.0, dislike: 0.3, comment: 1.2 };
const LAMBDA_DIM = 0.3;             // abnehmende Ertraege pro Actor->Creator-Paar
const REFERRAL_RATE = 0.10;        // 10 % der Token einer eingeladenen Person gehen an den Einladenden (abgezogen)
const INVITE_SEAT_PRICE = 2.00;    // EUR-Credits pro Einladungsplatz

/* ---------- Datenbank ---------- */
let db = { users: {}, posts: [], sessions: {}, events: [], meta: null };
/* Geheimer Salt fuer E-Mail-Fingerabdruecke (liegt getrennt von der DB, gitignored) */
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
let SECRET = '';
function loadSecret() {
  try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) {}
  if (!SECRET) {
    SECRET = crypto.randomBytes(32).toString('hex');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, SECRET);
  }
}
function emailHash(email) {
  return crypto.createHash('sha256').update(SECRET + ':' + String(email).trim().toLowerCase()).digest('hex');
}

function normalizeDb() {
  db.users = db.users || {}; db.posts = db.posts || []; db.sessions = db.sessions || {};
  db.events = db.events || [];
  db.stats = db.stats || {};
  db.friendRequests = db.friendRequests || [];
  db.messages = db.messages || [];
  db.offers = db.offers || [];
  db.trades = db.trades || [];
  db.invites = db.invites || {};   // code -> { owner, seatsTotal, seatsUsed, createdAt }
  if (!db.meta) db.meta = { lastDay: dayStr(Date.now() - 86400000), carryover: 0, totalDistributed: 0 };
  // Datenschutz-Migration: Klartext-E-Mails in Fingerabdruecke umwandeln und loeschen
  for (const k of Object.keys(db.users)) {
    const u = db.users[k];
    if (u.email) { u.emailHash = emailHash(u.email); delete u.email; }
    // Medien-Auslagerung: Inline-Base64-Avatare in Dateien schreiben (einmalig, idempotent)
    if (u.avatar && String(u.avatar).indexOf('data:') === 0) {
      const p = saveImageFile(u.avatar, 'av'); if (p) u.avatar = p;
    }
  }
  for (const post of db.posts) {
    if (post.image && String(post.image).indexOf('data:') === 0) {
      const f = saveImageFile(post.image, 'img'); if (f) post.image = f;
    }
  }
}

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  store.init(SQLITE_FILE);
  if (store.isEmpty() && fs.existsSync(DB_FILE)) {
    // Einmalige Migration: bestehende db.json in SQLite überführen
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = store.emptyDb(); }
    normalizeDb();
    store.persist(db);
    try { fs.renameSync(DB_FILE, DB_FILE + '.migrated'); } catch (e) {}
    console.log('[db] db.json → SQLite migriert (' + Object.keys(db.users).length + ' Nutzer, ' + db.posts.length + ' Posts).');
  } else {
    db = store.load();
    normalizeDb();
  }
}

/* Tages-Statistik: Zähler erhöhen und Nutzer als aktiv markieren */
function stat(field, amount, userKey) {
  const d = dayStr(Date.now());
  const s = db.stats[d] = db.stats[d] || { logins: 0, regs: 0, guests: 0, posts: 0, comments: 0, likes: 0, dislikes: 0, burn: 0, act: {} };
  if (field) s[field] = Math.round(((s[field] || 0) + amount) * 100) / 100;
  if (userKey) s.act[userKey] = 1;
}
function dayStr(t) { return new Date(t).toISOString().slice(0, 10); }
function saveDb() { store.persist(db); } // schreibt nur die geänderten Zeilen nach SQLite
loadSecret();
loadDb();
saveDb(); // eventuelle Normalisierung (z. B. E-Mail-Hashing) sofort persistieren

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
    key: key, name: u.name, hasEmail: !!u.emailHash, notifyConsent: !!u.notifyConsent,
    createdAt: u.createdAt, avatar: u.avatar || null, guest: !!u.guest,
    credits: u.credits, burn: u.burn, actions: u.actions,
    tokens: u.tokens || 0, startClaimed: !!u.startClaimed,
    sbtc: u.sbtc || 0,
    referredBy: u.referredBy || null, referralEarned: u.referralEarned || 0,
    unreadNotifications: (u.notifications || []).filter(n => !n.read).length
  };
}

function saveVideo(dataUrl) {
  const m = dataUrl.match(/^data:video\/(webm|mp4);base64,(.+)$/);
  if (!m) return null;
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const fname = newId('vid') + '.' + m[1];
  fs.writeFileSync(path.join(MEDIA_DIR, fname), Buffer.from(m[2], 'base64'));
  return '/media/' + fname;
}
function saveImageFile(dataUrl, prefix) {
  const m = String(dataUrl).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
  if (!m) return null;
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const fname = newId(prefix) + '.' + ext;
  fs.writeFileSync(path.join(MEDIA_DIR, fname), Buffer.from(m[2], 'base64'));
  return '/media/' + fname;
}
function deleteMedia(p) {
  if (!p || String(p).indexOf('/media/') !== 0) return;
  const f = path.join(MEDIA_DIR, path.basename(p));
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}
const deleteVideo = deleteMedia; // Alias (löscht jede /media-Datei per Basename)

function postPayload(p) {
  return {
    id: p.id, text: p.text, image: p.image || null, video: p.video || null, createdAt: p.createdAt,
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
    name: name, passHash: passHash, emailHash: email ? emailHash(email) : null, notifyConsent: !!email,
    createdAt: new Date().toISOString(), avatar: null, guest: !!guest,
    credits: 0, burn: 0, actions: 0,
    tokens: 0, startClaimed: false, tokenHistory: [],
    sbtc: 0, lastFaucet: null,
    referredBy: null, referralEarned: 0, referralContributed: 0
  };
}

/* ---------- E-Mail-Versand (minimaler SMTP-Client, TLS + AUTH LOGIN) ----------
   Konfiguration: data/mail-config.json, z. B.
   { "host": "smtp.gmail.com", "port": 465, "user": "adresse@gmail.com",
     "pass": "app-passwort", "from": "PoolSite <adresse@gmail.com>" }
   Ohne Konfiguration werden Reset-Codes in die Server-Konsole geschrieben. */
const MAIL_CONFIG_FILE = path.join(DATA_DIR, 'mail-config.json');
function mailConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(MAIL_CONFIG_FILE, 'utf8'));
    if (c.host && c.user && c.pass && c.pass.indexOf('HIER-') < 0) return c;
  } catch (e) {}
  return null;
}

function sendMail(cfg, to, subject, text) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(cfg.port || 465, cfg.host, { servername: cfg.host });
    const fromAddr = cfg.user;
    const fromHeader = cfg.from || ('PoolSite <' + fromAddr + '>');
    let buf = '';
    let done = false;
    const timer = setTimeout(() => fail(new Error('SMTP-Timeout')), 20000);

    function fail(err) {
      if (done) return;
      done = true; clearTimeout(timer);
      try { sock.destroy(); } catch (e) {}
      reject(err);
    }
    function ok() {
      if (done) return;
      done = true; clearTimeout(timer);
      try { sock.end(); } catch (e) {}
      resolve();
    }

    const message =
      'From: ' + fromHeader + '\r\n' +
      'To: <' + to + '>\r\n' +
      'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=\r\n' +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Content-Transfer-Encoding: base64\r\n' +
      '\r\n' +
      Buffer.from(text).toString('base64').replace(/(.{76})/g, '$1\r\n') +
      '\r\n.';

    const steps = [
      { expect: 220, send: 'EHLO poolsite.local' },
      { expect: 250, send: 'AUTH LOGIN' },
      { expect: 334, send: Buffer.from(cfg.user).toString('base64') },
      { expect: 334, send: Buffer.from(cfg.pass).toString('base64') },
      { expect: 235, send: 'MAIL FROM:<' + fromAddr + '>' },
      { expect: 250, send: 'RCPT TO:<' + to + '>' },
      { expect: 250, send: 'DATA' },
      { expect: 354, send: message },
      { expect: 250, send: 'QUIT', thenOk: true }
    ];
    let idx = 0;

    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      // vollständige Antwort: letzte Zeile hat "NNN " (Leerzeichen, nicht Bindestrich)
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return;
      const code = parseInt(last.slice(0, 3), 10);
      buf = '';
      const step = steps[idx];
      if (!step) return ok();
      if (code !== step.expect) return fail(new Error('SMTP-Fehler (' + code + '): ' + last.slice(4, 120)));
      sock.write(step.send + '\r\n');
      if (step.thenOk) return ok();
      idx += 1;
    });
    sock.on('error', fail);
  });
}

/* Mitteilungen: pro Nutzer eine kleine Timeline (letzte 50) */
function notify(userKey, type, text, fromKey) {
  const u = db.users[userKey];
  if (!u || userKey === fromKey) return;
  u.notifications = u.notifications || [];
  // Chat-Nachrichten nicht stapeln: eine ungelesene Meldung pro Absender reicht
  if (type === 'chat' && u.notifications.some(n => !n.read && n.type === 'chat' && n.from === fromKey)) return;
  u.notifications.push({ id: newId('n'), type: type, text: text, from: fromKey || null, at: new Date().toISOString(), read: false });
  if (u.notifications.length > 50) u.notifications = u.notifications.slice(-50);
}
function snippet(s) {
  s = String(s || '').trim();
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

function findOpenInvite(code) {
  const inv = db.invites[String(code || '').trim()];
  if (!inv || inv.seatsUsed >= inv.seatsTotal || !db.users[inv.owner]) return null;
  return inv;
}

/* ---------- Standing & tägliche Token-Verteilung ---------- */
function alphaHat(u) { return (u.burn / Math.max(u.actions, 1)) / NU; }
function lam(x) { return x / (1 + x); }
function addHistory(u, day, amount) {
  u.tokenHistory = u.tokenHistory || [];
  const e = u.tokenHistory.find(h => h.day === day);
  if (e) e.amount = Math.round((e.amount + amount) * 100) / 100;
  else u.tokenHistory.push({ day: day, amount: amount });
}

function logEvent(type, actorKey, creatorKey) {
  if (actorKey === creatorKey) return; // Selbst-Engagement zählt nicht
  db.events.push({ d: dayStr(Date.now()), t: type, a: actorKey, c: creatorKey });
}

function dayWeights(day) {
  const weights = {}; const pairCount = {};
  for (const e of db.events) {
    if (e.d !== day) continue;
    const actor = db.users[e.a];
    if (!actor || actor.guest) continue;              // Gäste geben kein Gewicht
    const creator = db.users[e.c];
    if (!creator || creator.guest) continue;          // Gäste erhalten keine Token
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
      let credited = 0; // tatsächlich gutgeschriebene Token (Rundungsrest -> Carryover)
      for (const k of Object.keys(weights)) {
        const u = db.users[k];
        if (!u) continue;
        const amt = Math.round(pool * weights[k] / total * 100) / 100;
        credited = Math.round((credited + amt) * 100) / 100;
        let net = amt;
        // Referral: 10 % gehen an die Person, die diesen Nutzer eingeladen hat
        const ref = u.referredBy ? db.users[u.referredBy] : null;
        if (ref) {
          const cut = Math.round(amt * REFERRAL_RATE * 100) / 100;
          if (cut > 0) {
            net = Math.round((amt - cut) * 100) / 100;
            ref.tokens = Math.round(((ref.tokens || 0) + cut) * 100) / 100;
            ref.referralEarned = Math.round(((ref.referralEarned || 0) + cut) * 100) / 100;
            addHistory(ref, next, cut);
            u.referralContributed = Math.round(((u.referralContributed || 0) + cut) * 100) / 100;
            notify(u.referredBy, 'tokens', 'Referral: +' + cut + ' PST von ' + u.name + ' (Verteilung ' + next + ').');
          }
        }
        u.tokens = Math.round(((u.tokens || 0) + net) * 100) / 100;
        addHistory(u, next, net);
        notify(k, 'tokens', 'Tagesverteilung ' + next + ': +' + net + ' PST für dein Engagement.');
      }
      db.meta.totalDistributed = Math.round((db.meta.totalDistributed + credited) * 100) / 100;
      db.meta.carryover = Math.max(0, Math.round((pool - credited) * 100) / 100); // Rundungsstaub wandert in den nächsten Tag
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

    // Registrierung nur per Einladung (Ausnahme: allererstes Konto im Netzwerk)
    const realUsers = Object.keys(db.users).filter(x => !db.users[x].guest).length;
    let inv = null;
    if (realUsers > 0) {
      inv = findOpenInvite(body.inviteCode);
      if (!inv) return json(res, 403, { error: 'Registrierung nur mit gültigem Einladungscode möglich. Frag ein Mitglied nach einer Einladung.' });
    }

    const rec = newUserRecord(name, sha(k + ':' + pass), email, false);
    rec.credits = START_CREDITS;      // 10 € Startguthaben für eingeladene Konten
    rec.startClaimed = true;
    if (inv) { rec.referredBy = inv.owner; inv.seatsUsed += 1; notify(inv.owner, 'invite', name + ' ist über deine Einladung beigetreten.'); }
    db.users[k] = rec;
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

  /* ---------- Passwort zurücksetzen (nur mit hinterlegter E-Mail) ---------- */
  if (pathname === '/api/reset/request' && req.method === 'POST') {
    const k = String(body.username || '').trim().toLowerCase();
    const em = String(body.email || '').trim().toLowerCase();
    const u = db.users[k];
    const generic = { ok: true, message: 'Falls Nutzername und E-Mail zusammenpassen, wurde ein Code verschickt (15 Minuten gültig).' };
    // Wir speichern keine Adressen — nur der Fingerabdruck wird verglichen; gesendet wird an die soeben eingegebene Adresse
    if (!u || u.guest || !u.emailHash || emailHash(em) !== u.emailHash) return json(res, 200, generic);
    if (u.reset && Date.now() - (u.reset.requestedAt || 0) < 2 * 60 * 1000) {
      return json(res, 429, { error: 'Bitte warte 2 Minuten, bevor du einen neuen Code anforderst.' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    u.reset = { codeHash: sha(k + ':' + code), exp: Date.now() + 15 * 60 * 1000, tries: 0, requestedAt: Date.now() };
    saveDb();
    const cfg = mailConfig();
    const mailText = 'Hallo ' + u.name + ',\n\n' +
      'dein PoolSite-Code zum Zurücksetzen des Passworts lautet:\n\n    ' + code + '\n\n' +
      'Der Code ist 15 Minuten gültig. Wenn du das nicht angefordert hast, ignoriere diese E-Mail.\n\n— PoolSite';
    if (cfg) {
      sendMail(cfg, em, 'PoolSite: Passwort zurücksetzen', mailText)
        .then(() => console.log('[mail] Reset-Code an verifizierte Adresse von ' + k + ' gesendet'))
        .catch(err => console.error('[mail] Versand fehlgeschlagen (' + err.message + ') — Code für ' + k + ': ' + code));
    } else {
      console.log('[mail] Kein Mail-Server konfiguriert (data/mail-config.json). Reset-Code für ' + k + ': ' + code);
    }
    return json(res, 200, generic);
  }

  if (pathname === '/api/reset/confirm' && req.method === 'POST') {
    const k = String(body.username || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const pass = String(body.password || '');
    const u = db.users[k];
    if (!u || !u.reset) return json(res, 400, { error: 'Kein offener Reset-Vorgang — fordere zuerst einen Code an.' });
    if (Date.now() > u.reset.exp) { delete u.reset; saveDb(); return json(res, 400, { error: 'Der Code ist abgelaufen — fordere einen neuen an.' }); }
    if (u.reset.tries >= 5) { delete u.reset; saveDb(); return json(res, 400, { error: 'Zu viele Fehlversuche — fordere einen neuen Code an.' }); }
    if (u.reset.codeHash !== sha(k + ':' + code)) {
      u.reset.tries += 1; saveDb();
      return json(res, 403, { error: 'Falscher Code (' + (5 - u.reset.tries) + ' Versuche übrig).' });
    }
    if (pass.length < 4) return json(res, 400, { error: 'Das neue Passwort muss mindestens 4 Zeichen haben.' });
    u.passHash = sha(k + ':' + pass);
    delete u.reset;
    for (const t of Object.keys(db.sessions)) if (db.sessions[t] === k) delete db.sessions[t]; // alte Sitzungen beenden
    saveDb();
    return json(res, 200, { ok: true, message: 'Passwort geändert — du kannst dich jetzt anmelden.' });
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
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const sort = qs.get('sort') || 'new';
    const type = qs.get('type') || 'all';
    const range = qs.get('range') || 'all';
    const friendsOnly = qs.get('friends') === '1';

    // Ranking-Score: Engagement gewichtet mit dem Standing-Kernel des Reagierenden
    // (konsistent zum Punktesystem — Reaktionen ohne Einsatz zaehlen ~0)
    function kernelOf(k2) {
      const u = db.users[k2];
      return u && u.actions > 0 ? lam(alphaHat(u)) : 0;
    }
    function contentScore(p) {
      let s = 0;
      (p.likes || []).forEach(k2 => { s += 1.0 * kernelOf(k2); });
      (p.dislikes || []).forEach(k2 => { s -= 0.4 * kernelOf(k2); });
      (p.comments || []).forEach(c => { if (c.author !== p.author) s += 1.2 * kernelOf(c.author); });
      return Math.round(s * 100) / 100;
    }
    function hotScore(p, score) {
      const ageH = (Date.now() - new Date(p.createdAt).getTime()) / 3600000;
      return score / Math.pow(ageH + 2, 1.5);
    }

    let list = db.posts.slice();

    if (type === 'image') list = list.filter(p => p.image);
    else if (type === 'video') list = list.filter(p => p.video);
    else if (type === 'text') list = list.filter(p => !p.image && !p.video);

    if (range === 'day') list = list.filter(p => Date.now() - new Date(p.createdAt) < 86400000);
    else if (range === 'week') list = list.filter(p => Date.now() - new Date(p.createdAt) < 7 * 86400000);

    if (friendsOnly && me) {
      const fset = {};
      (me.friends || []).forEach(f => { fset[f] = 1; });
      fset[key] = 1; // eigene Beitraege mit anzeigen
      list = list.filter(p => fset[p.author]);
    }

    const scored = list.map(p => {
      const score = contentScore(p);
      return { p: p, score: score, hot: hotScore(p, score) };
    });

    if (sort === 'top') scored.sort((a, b) => b.score - a.score || new Date(b.p.createdAt) - new Date(a.p.createdAt));
    else if (sort === 'hot') scored.sort((a, b) => b.hot - a.hot || new Date(b.p.createdAt) - new Date(a.p.createdAt));
    else if (sort === 'discussed') scored.sort((a, b) => (b.p.comments || []).length - (a.p.comments || []).length || new Date(b.p.createdAt) - new Date(a.p.createdAt));
    else scored.sort((a, b) => new Date(b.p.createdAt) - new Date(a.p.createdAt));

    return json(res, 200, {
      posts: scored.map(x => Object.assign(postPayload(x.p), { score: x.score }))
    });
  }

  // Ab hier: Anmeldung nötig
  if (!me) return json(res, 401, { error: 'Nicht angemeldet.' });

  if (pathname === '/api/me' && req.method === 'GET') return json(res, 200, { me: mePayload(key) });

  if (pathname === '/api/notifications' && req.method === 'GET') {
    const list = (me.notifications || []).slice().reverse();
    return json(res, 200, { notifications: list, me: mePayload(key) });
  }

  if (pathname === '/api/notifications/read' && req.method === 'POST') {
    (me.notifications || []).forEach(n => { n.read = true; });
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    for (const t of Object.keys(db.sessions)) if (db.sessions[t] === key) delete db.sessions[t];
    saveDb();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && req.method === 'DELETE') {
    db.posts.filter(p => p.author === key).forEach(p => { deleteMedia(p.video); deleteMedia(p.image); });
    deleteMedia(me.avatar);
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
    for (const c of Object.keys(db.invites)) if (db.invites[c].owner === key) delete db.invites[c];
    for (const k of Object.keys(db.users)) {
      const u = db.users[k];
      if (u.friends) u.friends = u.friends.filter(f => f !== key);
      if (u.lastRead) delete u.lastRead[key];
      if (u.referredBy === key) u.referredBy = null; // Einladender weg -> Eingeladene behalten kuenftig 100 %
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

    // Auch die Umwandlung eines Gast-Kontos braucht eine Einladung
    const realUsers = Object.keys(db.users).filter(x => !db.users[x].guest).length;
    let inv = null;
    if (realUsers > 0) {
      inv = findOpenInvite(body.inviteCode);
      if (!inv) return json(res, 403, { error: 'Ein echtes Konto braucht einen gültigen Einladungscode. Frag ein Mitglied nach einer Einladung.' });
    }

    db.users[nk] = Object.assign({}, me, {
      name: name, passHash: sha(nk + ':' + pass), emailHash: email ? emailHash(email) : null,
      notifyConsent: !!email, guest: false
    });
    if (!db.users[nk].startClaimed) {
      db.users[nk].credits = round2((db.users[nk].credits || 0) + START_CREDITS);
      db.users[nk].startClaimed = true;
    }
    if (inv) { db.users[nk].referredBy = inv.owner; inv.seatsUsed += 1; notify(inv.owner, 'invite', name + ' ist über deine Einladung beigetreten.'); }
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
    for (const c of Object.keys(db.invites)) if (db.invites[c].owner === key) db.invites[c].owner = nk;
    for (const k2 of Object.keys(db.users)) if (db.users[k2].referredBy === key) db.users[k2].referredBy = nk;
    for (const k of Object.keys(db.users)) {
      const u = db.users[k];
      if (u.friends) u.friends = u.friends.map(f => f === key ? nk : f);
      if (u.lastRead && u.lastRead[key] !== undefined) { u.lastRead[nk] = u.lastRead[key]; delete u.lastRead[key]; }
    }
    saveDb();
    return json(res, 200, { me: mePayload(nk) });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    if (body.email !== undefined) {
      const em = String(body.email || '').trim();
      if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return json(res, 400, { error: 'Ungültige E-Mail-Adresse.' });
      me.emailHash = em ? emailHash(em) : null; // nie im Klartext gespeichert
      me.notifyConsent = !!em;
    }
    if (body.newPassword) {
      if (me.guest) return json(res, 400, { error: 'Gast-Konten haben kein Passwort — wandle dein Konto zuerst um.' });
      const np = String(body.newPassword);
      if (np.length < 4) return json(res, 400, { error: 'Das neue Passwort muss mindestens 4 Zeichen haben.' });
      if (me.passHash !== sha(key + ':' + String(body.currentPassword || ''))) {
        return json(res, 403, { error: 'Das aktuelle Passwort ist falsch.' });
      }
      me.passHash = sha(key + ':' + np);
    }
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  if (pathname === '/api/avatar' && req.method === 'POST') {
    const d = String(body.dataUrl || '');
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(d) || d.length > 200000) {
      return json(res, 400, { error: 'Ungültiges oder zu großes Bild.' });
    }
    const p = saveImageFile(d, 'av'); // als Datei speichern statt inline
    if (!p) return json(res, 400, { error: 'Bild konnte nicht gespeichert werden.' });
    deleteMedia(me.avatar); // altes Avatarbild entfernen
    me.avatar = p;
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  /* ---------- Einladungen ---------- */
  if (pathname === '/api/invites' && req.method === 'GET') {
    const mine = Object.keys(db.invites)
      .filter(c => db.invites[c].owner === key)
      .map(c => ({ code: c, seatsTotal: db.invites[c].seatsTotal, seatsUsed: db.invites[c].seatsUsed, createdAt: db.invites[c].createdAt }));
    const invitees = Object.keys(db.users)
      .filter(k2 => db.users[k2].referredBy === key)
      .map(k2 => ({ name: db.users[k2].name, contributed: db.users[k2].referralContributed || 0 }));
    return json(res, 200, { invites: mine, invitees: invitees, seatPrice: INVITE_SEAT_PRICE, referralPct: REFERRAL_RATE * 100 });
  }

  if (pathname === '/api/invites' && req.method === 'POST') {
    if (me.guest) return json(res, 403, { error: 'Nur volle Konten können Einladungen erstellen.' });
    const seats = Math.floor(+body.seats || 0);
    if (!(seats >= 1 && seats <= 100)) return json(res, 400, { error: 'Plätze: 1 bis 100.' });
    const cost = round2(seats * INVITE_SEAT_PRICE);
    if (me.credits + 1e-9 < cost) return json(res, 402, { error: 'Nicht genug Guthaben — ' + seats + ' Plätze kosten ' + cost.toFixed(2).replace('.', ',') + ' €.' });
    me.credits = round2(me.credits - cost);
    me.burn = round2(me.burn + cost);   // bezahlte Einladungen sind irreversibler Einsatz -> Commitment B
    me.actions += 1;
    const code = crypto.randomBytes(4).toString('hex');
    db.invites[code] = { owner: key, seatsTotal: seats, seatsUsed: 0, createdAt: new Date().toISOString() };
    stat(null, 0, key);
    saveDb();
    return json(res, 200, { code: code, me: mePayload(key) });
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
    const lastT = db.trades[db.trades.length - 1];
    const lastPrice = lastT
      ? Math.round((lastT.currency === 'SBTC' ? lastT.pricePerToken * SBTC_RATE : lastT.pricePerToken) * 10000) / 10000
      : null;
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

  /* ---------- sBTC: Faucet & Burn (Demo-Bitcoin) — nicht für Gäste ---------- */
  if (pathname === '/api/btc/faucet' && req.method === 'POST') {
    if (me.guest) return json(res, 403, { error: 'Nur für volle Konten — der Gast-Zugang ist zum Umsehen da. Lass dich einladen, um mitzumachen.' });
    const today = dayStr(Date.now());
    if (me.lastFaucet === today) return json(res, 400, { error: 'Faucet heute schon genutzt — morgen wieder.' });
    me.lastFaucet = today;
    me.sbtc = r8((me.sbtc || 0) + FAUCET_AMOUNT);
    stat(null, 0, key);
    saveDb();
    return json(res, 200, { me: mePayload(key) });
  }

  if (pathname === '/api/btc/burn' && req.method === 'POST') {
    if (me.guest) return json(res, 403, { error: 'Nur für volle Konten — der Gast-Zugang ist zum Umsehen da.' });
    const amount = r8(+body.amount || 0);
    if (!(amount > 0)) return json(res, 400, { error: 'Ungültige Menge.' });
    if ((me.sbtc || 0) + 1e-12 < amount) return json(res, 400, { error: 'Nicht genug sBTC — du hast ' + (me.sbtc || 0).toFixed(8) + '.' });
    const credits = round2(amount * SBTC_RATE);
    if (credits < 0.01) return json(res, 400, { error: 'Menge zu klein — ergibt weniger als 0,01 €.' });
    me.sbtc = r8(me.sbtc - amount);
    me.credits = round2(me.credits + credits);
    db.meta.sbtcBurned = r8((db.meta.sbtcBurned || 0) + amount);
    stat(null, 0, key);
    saveDb();
    return json(res, 200, { me: mePayload(key), credited: credits, deadAddress: DEAD_ADDRESS });
  }

  /* ---------- Markt: Token-Handel zwischen Nutzern ---------- */
  const TRADE_FEE = 0.04; // 4 % Plattformgebühr (2 % Treasury + 1 % Pool + 1 % Referral)

  function eurEquiv(price, currency) { return currency === 'SBTC' ? price * SBTC_RATE : price; }

  if (pathname === '/api/market' && req.method === 'GET') {
    const offers = db.offers.slice()
      .sort((a, b) => eurEquiv(a.pricePerToken, a.currency || 'EUR') - eurEquiv(b.pricePerToken, b.currency || 'EUR'))
      .map(o => ({
        id: o.id, amount: o.amount, pricePerToken: o.pricePerToken,
        currency: o.currency || 'EUR',
        total: o.currency === 'SBTC' ? r8(o.amount * o.pricePerToken) : round2(o.amount * o.pricePerToken),
        seller: publicUser(o.seller), mine: o.seller === key, createdAt: o.createdAt
      }));
    const trades = db.trades.slice(-30).reverse().map(t => ({
      amount: t.amount, pricePerToken: t.pricePerToken, currency: t.currency || 'EUR',
      total: t.total, at: t.at,
      buyer: publicUser(t.buyer).name, seller: publicUser(t.seller).name
    }));
    const lastTrade = db.trades[db.trades.length - 1];
    const lastPrice = lastTrade ? Math.round(eurEquiv(lastTrade.pricePerToken, lastTrade.currency || 'EUR') * 10000) / 10000 : null;
    return json(res, 200, {
      offers: offers, trades: trades, lastPrice: lastPrice,
      feePct: TRADE_FEE * 100, sbtcRate: SBTC_RATE, me: mePayload(key)
    });
  }

  if (pathname === '/api/market/offers' && req.method === 'POST') {
    if (me.guest) return json(res, 403, { error: 'Nur für volle Konten — Gäste können nicht mit Token handeln.' });
    const currency = body.currency === 'SBTC' ? 'SBTC' : 'EUR';
    const amount = Math.round((+body.amount || 0) * 100) / 100;
    const price = currency === 'SBTC'
      ? r8(+body.pricePerToken || 0)
      : Math.round((+body.pricePerToken || 0) * 10000) / 10000;
    if (!(amount >= 1)) return json(res, 400, { error: 'Mindestmenge: 1 PST.' });
    if (currency === 'EUR' && !(price >= 0.0001 && price <= 1000)) return json(res, 400, { error: 'Preis pro Token: 0,0001 € bis 1.000 €.' });
    if (currency === 'SBTC' && !(price >= 1e-8 && price <= 1)) return json(res, 400, { error: 'Preis pro Token: 0,00000001 bis 1 sBTC.' });
    if ((me.tokens || 0) + 1e-9 < amount) return json(res, 400, { error: 'Nicht genug Token — du hast ' + (me.tokens || 0) + ' PST.' });
    me.tokens = round2(me.tokens - amount); // Treuhand: Token sind ab jetzt im Angebot gebunden
    db.offers.push({ id: newId('off'), seller: key, amount: amount, pricePerToken: price, currency: currency, createdAt: new Date().toISOString() });
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
    if (me.guest) return json(res, 403, { error: 'Nur für volle Konten — Gäste können nicht mit Token handeln.' });
    const offer = db.offers.find(o => o.id === mBuy[1]);
    if (!offer) return json(res, 404, { error: 'Angebot nicht mehr verfügbar.' });
    if (offer.seller === key) return json(res, 400, { error: 'Du kannst dein eigenes Angebot nicht kaufen.' });
    const amt = body.amount ? Math.round((+body.amount) * 100) / 100 : offer.amount;
    if (!(amt > 0) || amt - offer.amount > 1e-9) return json(res, 400, { error: 'Ungültige Menge (verfügbar: ' + offer.amount + ' PST).' });
    const cur = offer.currency || 'EUR';
    const seller = db.users[offer.seller];

    let total, fee, proceeds;
    if (cur === 'SBTC') {
      total = r8(amt * offer.pricePerToken);
      if (total < 1e-8) return json(res, 400, { error: 'Kaufbetrag zu klein.' });
      if ((me.sbtc || 0) + 1e-12 < total) return json(res, 402, { error: 'Nicht genug sBTC — Kauf kostet ' + total.toFixed(8) + ' sBTC.' });
      fee = r8(total * TRADE_FEE);
      proceeds = r8(total - fee);
      me.sbtc = r8(me.sbtc - total);
      if (seller) {
        seller.sbtc = r8((seller.sbtc || 0) + proceeds);
        seller.burn = round2(seller.burn + fee * SBTC_RATE); // Gebühr (EUR-Gegenwert) -> Commitment B
      }
    } else {
      total = round2(amt * offer.pricePerToken);
      if (total < 0.01) return json(res, 400, { error: 'Kaufbetrag zu klein (min. 0,01 €).' });
      if (me.credits + 1e-9 < total) return json(res, 402, { error: 'Nicht genug Guthaben — Kauf kostet ' + total.toFixed(2).replace('.', ',') + ' €.' });
      fee = round2(total * TRADE_FEE);
      proceeds = round2(total - fee);
      me.credits = round2(me.credits - total);
      if (seller) {
        seller.credits = round2(seller.credits + proceeds);
        seller.burn = round2(seller.burn + fee); // Gebühr ist unwiderruflich weg -> zählt ins Commitment B
      }
    }
    me.tokens = round2((me.tokens || 0) + amt);
    offer.amount = round2(offer.amount - amt);
    if (offer.amount < 0.01) db.offers = db.offers.filter(o => o.id !== offer.id);
    notify(offer.seller, 'trade',
      me.name + ' hat ' + amt + ' PST aus deinem Angebot gekauft (' +
      (cur === 'SBTC' ? total.toFixed(8) + ' sBTC' : total.toFixed(2).replace('.', ',') + ' €') + ' erhalten, abzgl. Gebühr).', key);
    db.trades.push({ id: newId('tr'), buyer: key, seller: offer.seller, amount: amt, pricePerToken: offer.pricePerToken, currency: cur, total: total, at: new Date().toISOString() });
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
      notify(to, 'friend', me.name + ' und du seid jetzt befreundet.', key);
      saveDb();
      return json(res, 200, { ok: true, becameFriends: true });
    }
    db.friendRequests.push({ from: key, to: to, at: new Date().toISOString() });
    notify(to, 'friend_request', me.name + ' hat dir eine Freundschaftsanfrage geschickt.', key);
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
      notify(from, 'friend', me.name + ' hat deine Freundschaftsanfrage angenommen.', key);
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
    notify(other, 'chat', 'Neue Nachricht von ' + me.name + '.', key);
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
      image = saveImageFile(d, 'img'); // als Datei speichern, nur den Pfad in der DB ablegen
      if (!image) return json(res, 400, { error: 'Bild konnte nicht gespeichert werden.' });
    }
    let video = null;
    if (body.video) {
      const d = String(body.video);
      if (!/^data:video\/(webm|mp4);base64,/.test(d)) return json(res, 400, { error: 'Ungültiges Videoformat.' });
      if (d.length > MAX_VIDEO) return json(res, 400, { error: 'Video zu groß (max. ~2 MB nach Kompression).' });
      video = saveVideo(d);
      if (!video) return json(res, 400, { error: 'Video konnte nicht gespeichert werden.' });
    }
    if (!text && !image && !video) return json(res, 400, { error: 'Schreib etwas oder füge ein Bild/Video hinzu.' });
    const pay = charge(me, 'post');
    if (!pay.ok) { deleteMedia(video); deleteMedia(image); return json(res, 402, { error: pay.error }); }
    db.posts.push({ id: newId('post'), author: key, text: text, image: image, video: video, createdAt: new Date().toISOString(), likes: [], dislikes: [], comments: [] });
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
      notify(p.author, kind === 'likes' ? 'like' : 'dislike',
        me.name + (kind === 'likes' ? ' gefällt dein Beitrag' : ' hat deinen Beitrag gedislikt') + (p.text ? ': „' + snippet(p.text) + '"' : '.'), key);
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
    notify(p.author, 'comment', me.name + ' hat kommentiert: „' + snippet(text) + '"', key);
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
    deleteMedia(p.video); deleteMedia(p.image);
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
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webm': 'video/webm', '.mp4': 'video/mp4'
};
function serveStatic(res, pathname) {
  // Hochgeladene Medien aus data/media ausliefern
  if (pathname.startsWith('/media/')) {
    const mf = path.join(MEDIA_DIR, path.basename(pathname));
    return fs.readFile(mf, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Nicht gefunden'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(mf)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' });
      res.end(buf);
    });
  }
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

// Automatische Backups: einmal beim Start, danach taeglich
try {
  const backup = require('./backup');
  backup.runBackup({ quiet: true });
  setInterval(() => { try { backup.runBackup({ quiet: true }); } catch (e) { console.error('[backup]', e.message); } }, 24 * 3600 * 1000);
} catch (e) { console.error('[backup] nicht verfuegbar:', e.message); }

server.listen(PORT, '0.0.0.0', () => {
  console.log('PoolSite-Server läuft: http://localhost:' + PORT);
});

// Beim Beenden WAL in die Hauptdatei schreiben, damit Backups konsistent sind
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { try { store.close(); } catch (e) {} process.exit(0); }));
