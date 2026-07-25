/* PoolSite Kern — Dual-Modus:
   1) Server-Modus: echte geteilte Konten & Posts über die PoolSite-API
   2) Lokal-Modus (Fallback): alles im localStorage dieses Browsers
   Die API-Adresse kann per ?api=https://... gesetzt werden (wird gespeichert). */
var PS = (function () {
  var USERS_KEY = 'poolsite_users';
  var SESSION_KEY = 'poolsite_session';
  var POSTS_KEY = 'poolsite_posts';
  var TOKEN_KEY = 'poolsite_token';
  var API_KEY = 'poolsite_api';
  var GUEST_KEY = '__guest';

  var START_CREDITS = 10.00;
  var PRICES = { post: 0.10, comment: 0.05, like: 0.02, dislike: 0.02 };

  var mode = 'local';
  var apiBase = '';
  var cachedMe = null;

  /* ---------- gemeinsame Helfer ---------- */
  function round2(n) { return Math.round(n * 100) / 100; }
  function fmtEur(n) {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function timeAgo(iso) {
    var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'gerade eben';
    var m = Math.floor(s / 60); if (m < 60) return 'vor ' + m + ' Min.';
    var h = Math.floor(m / 60); if (h < 24) return 'vor ' + h + ' Std.';
    var d = Math.floor(h / 24); if (d < 7) return 'vor ' + d + ' Tag' + (d > 1 ? 'en' : '');
    return new Date(iso).toLocaleDateString('de-DE');
  }
  // Medien-Pfade (/media/...) müssen vom API-Server geladen werden, auch wenn
  // das Frontend auf einer anderen Adresse läuft (z. B. GitHub Pages + Tunnel-API).
  function media(u) {
    if (u && apiBase && u.indexOf('/media/') === 0) return apiBase + u;
    return u;
  }
  function avatarHtml(who) {
    if (who && who.avatar) { return '<img src="' + media(who.avatar) + '" alt="">'; }
    var ch = who && who.name ? who.name.charAt(0).toUpperCase() : '?';
    return '<span>' + ch + '</span>';
  }
  function hashStr(str) {
    if (window.crypto && crypto.subtle) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      });
    }
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
    return Promise.resolve('fb_' + h.toString(16));
  }

  /* ---------- Server-Modus ---------- */
  function call(path, method, body) {
    var headers = { 'Content-Type': 'application/json' };
    var token = localStorage.getItem(TOKEN_KEY);
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(apiBase + path, {
      method: method || 'GET',
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || 'Serverfehler (' + r.status + ')');
        return data;
      });
    });
  }

  /* ---------- Lokal-Modus (Fallback, wie bisher) ---------- */
  function lUsers() { try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; } catch (e) { return {}; } }
  function lSaveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }
  function lPosts() { try { return JSON.parse(localStorage.getItem(POSTS_KEY)) || []; } catch (e) { return []; } }
  function lSavePosts(p) { localStorage.setItem(POSTS_KEY, JSON.stringify(p)); }
  function lSession() { return localStorage.getItem(SESSION_KEY); }

  function lEnsure(rec) {
    if (rec && rec.credits === undefined) { rec.credits = 0; rec.burn = 0; rec.actions = 0; }
    return rec;
  }
  function lMe() {
    var k = lSession(); if (!k) return null;
    var rec = lUsers()[k]; if (!rec) return null;
    lEnsure(rec);
    return {
      key: k, name: rec.name, hasEmail: !!rec.email, notifyConsent: !!rec.notifyConsent,
      createdAt: rec.createdAt, avatar: rec.avatar || null, guest: !!rec.guest,
      credits: rec.credits, burn: rec.burn, actions: rec.actions,
      tokens: rec.tokens || 0, startClaimed: !!rec.startClaimed
    };
  }
  function lCharge(action) {
    var users = lUsers(); var rec = users[lSession()];
    if (!rec) return { ok: false, error: 'Nicht angemeldet.' };
    lEnsure(rec);
    var price = PRICES[action] || 0;
    if (rec.credits + 1e-9 < price) return { ok: false, error: 'Nicht genug Guthaben — diese Aktion kostet ' + fmtEur(price) + '.' };
    rec.credits = round2(rec.credits - price);
    rec.burn = round2(rec.burn + price);
    rec.actions += 1;
    lSaveUsers(users);
    return { ok: true };
  }
  function lPublic(users, k) {
    var u = users[k];
    return u ? { key: k, name: u.name, avatar: u.avatar || null } : { key: k, name: 'Ehemaliger Nutzer', avatar: null };
  }
  function lPostPayload(users, p) {
    return {
      id: p.id, text: p.text, image: p.image || null, video: p.video || null, createdAt: p.createdAt,
      author: lPublic(users, p.author), authorKey: p.author,
      likes: p.likes || [], dislikes: p.dislikes || [],
      comments: (p.comments || []).map(function (c) {
        return { id: c.id, text: c.text, createdAt: c.createdAt, author: lPublic(users, c.author), authorKey: c.author };
      })
    };
  }
  var USER_RE = /^[A-Za-z0-9][A-Za-z0-9._]{1,29}$/;
  function lValidate(name, pass) {
    if (!USER_RE.test(name)) return 'Nutzername: 2–30 Zeichen, beginnt mit Buchstabe/Zahl; erlaubt sind Buchstaben, Zahlen, Punkt, Unterstrich.';
    if (pass.length < 4) return 'Das Passwort muss mindestens 4 Zeichen haben.';
    if (lUsers()[name.toLowerCase()]) return 'Dieser Nutzername ist bereits vergeben.';
    return null;
  }

  /* ---------- Öffentliche API (immer async) ---------- */
  function init() {
    // API-Adresse aus URL-Parameter übernehmen (?api=https://xyz.trycloudflare.com)
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('api')) localStorage.setItem(API_KEY, q.get('api').replace(/\/$/, ''));
    } catch (e) {}
    var stored = localStorage.getItem(API_KEY);
    apiBase = stored || '';

    try { setupPWA(); } catch (e) {}
    return fetch(apiBase + '/api/health', { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.mode === 'server') { mode = 'server'; return refreshMe().then(function () { startNotifPoller(); }); }
        mode = 'local'; cachedMe = lMe();
      })
      .catch(function () { mode = 'local'; cachedMe = lMe(); });
  }

  function refreshMe() {
    if (mode !== 'server') { cachedMe = lMe(); return Promise.resolve(cachedMe); }
    if (!localStorage.getItem(TOKEN_KEY)) { cachedMe = null; return Promise.resolve(null); }
    return call('/api/me').then(function (d) { cachedMe = d.me; return cachedMe; })
      .catch(function () { cachedMe = null; localStorage.removeItem(TOKEN_KEY); return null; });
  }

  function register(name, pass, email, inviteCode) {
    if (mode === 'server') {
      return call('/api/register', 'POST', { username: name, password: pass, email: email, inviteCode: inviteCode }).then(function (d) {
        localStorage.setItem(TOKEN_KEY, d.token); cachedMe = d.me; return d.me;
      });
    }
    var err = lValidate(name, pass);
    if (err) return Promise.reject(new Error(err));
    var k = name.toLowerCase();
    return hashStr(k + ':' + pass).then(function (ph) {
      var users = lUsers();
      users[k] = { name: name, passHash: ph, email: email || null, notifyConsent: !!email, createdAt: new Date().toISOString(), avatar: null, credits: START_CREDITS, burn: 0, actions: 0, tokens: 0, startClaimed: true };
      lSaveUsers(users);
      localStorage.setItem(SESSION_KEY, k);
      cachedMe = lMe(); return cachedMe;
    });
  }

  function login(name, pass) {
    if (mode === 'server') {
      return call('/api/login', 'POST', { username: name, password: pass }).then(function (d) {
        localStorage.setItem(TOKEN_KEY, d.token); cachedMe = d.me; return d.me;
      });
    }
    var k = name.toLowerCase();
    var rec = lUsers()[k];
    return hashStr(k + ':' + pass).then(function (ph) {
      if (!rec || rec.guest || rec.passHash !== ph) throw new Error('Nutzername oder Passwort ist falsch.');
      localStorage.setItem(SESSION_KEY, k);
      cachedMe = lMe(); return cachedMe;
    });
  }

  function guest() {
    if (mode === 'server') {
      return call('/api/guest', 'POST', {}).then(function (d) {
        localStorage.setItem(TOKEN_KEY, d.token); cachedMe = d.me; return d.me;
      });
    }
    var users = lUsers();
    if (!users[GUEST_KEY]) {
      users[GUEST_KEY] = { name: 'Gast', guest: true, passHash: null, email: null, notifyConsent: false, createdAt: new Date().toISOString(), avatar: null, credits: 0, burn: 0, actions: 0, tokens: 0, startClaimed: false };
      lSaveUsers(users);
    }
    localStorage.setItem(SESSION_KEY, GUEST_KEY);
    cachedMe = lMe(); return Promise.resolve(cachedMe);
  }

  function upgrade(name, pass, email, inviteCode) {
    if (mode === 'server') {
      return call('/api/upgrade', 'POST', { username: name, password: pass, email: email, inviteCode: inviteCode }).then(function (d) {
        cachedMe = d.me; return d.me;
      });
    }
    var err = lValidate(name, pass);
    if (err) return Promise.reject(new Error(err));
    var nk = name.toLowerCase();
    return hashStr(nk + ':' + pass).then(function (ph) {
      var users = lUsers();
      var g = lEnsure(users[GUEST_KEY]) || {};
      users[nk] = { name: name, passHash: ph, email: email || null, notifyConsent: !!email, createdAt: g.createdAt || new Date().toISOString(), avatar: g.avatar || null, credits: g.credits, burn: g.burn, actions: g.actions, tokens: g.tokens || 0, startClaimed: !!g.startClaimed };
      delete users[GUEST_KEY];
      lSaveUsers(users);
      var posts = lPosts();
      posts.forEach(function (p) {
        if (p.author === GUEST_KEY) p.author = nk;
        ['likes', 'dislikes'].forEach(function (kind) {
          var i = (p[kind] || []).indexOf(GUEST_KEY);
          if (i >= 0) p[kind][i] = nk;
        });
        (p.comments || []).forEach(function (c) { if (c.author === GUEST_KEY) c.author = nk; });
      });
      lSavePosts(posts);
      localStorage.setItem(SESSION_KEY, nk);
      cachedMe = lMe(); return cachedMe;
    });
  }

  function logout() {
    if (mode === 'server') {
      var done = call('/api/logout', 'POST', {}).catch(function () {});
      localStorage.removeItem(TOKEN_KEY);
      cachedMe = null;
      return done;
    }
    localStorage.removeItem(SESSION_KEY);
    cachedMe = null;
    return Promise.resolve();
  }

  function deleteAccount() {
    if (mode === 'server') {
      return call('/api/me', 'DELETE').then(function () {
        localStorage.removeItem(TOKEN_KEY); cachedMe = null;
      });
    }
    var k = lSession();
    var users = lUsers();
    delete users[k];
    lSaveUsers(users);
    lSavePosts(lPosts().filter(function (p) { return p.author !== k; }));
    localStorage.removeItem(SESSION_KEY);
    cachedMe = null;
    return Promise.resolve();
  }

  function setAvatar(dataUrl) {
    if (mode === 'server') {
      return call('/api/avatar', 'POST', { dataUrl: dataUrl }).then(function (d) { cachedMe = d.me; return d.me; });
    }
    var users = lUsers();
    var rec = users[lSession()];
    if (rec) { rec.avatar = dataUrl; lSaveUsers(users); }
    cachedMe = lMe(); return Promise.resolve(cachedMe);
  }

  function claimStart() {
    if (mode === 'server') {
      return call('/api/claim-start', 'POST', {}).then(function (d) { cachedMe = d.me; return d.me; });
    }
    var users = lUsers();
    var rec = lEnsure(users[lSession()]);
    if (!rec) return Promise.reject(new Error('Nicht angemeldet.'));
    if (rec.startClaimed) return Promise.reject(new Error('Du hast dein Startguthaben bereits abgeholt.'));
    rec.startClaimed = true;
    rec.credits = round2(rec.credits + START_CREDITS);
    lSaveUsers(users);
    cachedMe = lMe(); return Promise.resolve(cachedMe);
  }

  function wallet() {
    if (mode === 'server') {
      return call('/api/wallet').then(function (d) { cachedMe = d.me; return d.wallet; });
    }
    return Promise.resolve({ local: true, tokens: 0, history: [], yesterday: 0, todayWeight: 0, networkWeight: 0, projected: 0, poolToday: 5000, carryover: 0, totalDistributed: 0, nextDistribution: null });
  }

  function stats() {
    if (mode === 'server') {
      return call('/api/stats');
    }
    return Promise.resolve({ local: true, totals: {}, daily: [] });
  }

  /* Passwort zurücksetzen — nur im Live-Modus (braucht E-Mail-Versand) */
  function resetRequest(username, email) {
    if (mode !== 'server') return Promise.reject(new Error('Passwort-Reset gibt es nur im Live-Modus.'));
    return call('/api/reset/request', 'POST', { username: username, email: email });
  }
  function resetConfirm(username, code, password) {
    if (mode !== 'server') return Promise.reject(new Error('Passwort-Reset gibt es nur im Live-Modus.'));
    return call('/api/reset/confirm', 'POST', { username: username, code: code, password: password });
  }

  /* Einstellungen */
  function updateSettings(payload) {
    if (mode === 'server') {
      return call('/api/settings', 'POST', payload).then(function (d) { cachedMe = d.me; return d.me; });
    }
    var users = lUsers();
    var rec = users[lSession()];
    if (!rec) return Promise.reject(new Error('Nicht angemeldet.'));
    var chain = Promise.resolve();
    if (payload.email !== undefined) {
      var em = String(payload.email || '').trim();
      rec.email = em || null;
      rec.notifyConsent = !!em;
    }
    if (payload.notify !== undefined) rec.notifyConsent = !!payload.notify && !!rec.email;
    if (payload.newPassword) {
      if (rec.guest) return Promise.reject(new Error('Gast-Konten haben kein Passwort — wandle dein Konto zuerst um.'));
      if (String(payload.newPassword).length < 4) return Promise.reject(new Error('Das neue Passwort muss mindestens 4 Zeichen haben.'));
      var k = lSession();
      chain = hashStr(k + ':' + String(payload.currentPassword || '')).then(function (cur) {
        if (rec.passHash !== cur) throw new Error('Das aktuelle Passwort ist falsch.');
        return hashStr(k + ':' + String(payload.newPassword));
      }).then(function (nh) { rec.passHash = nh; });
    }
    return chain.then(function () {
      lSaveUsers(users);
      cachedMe = lMe(); return cachedMe;
    });
  }

  /* Walkthrough — geführte Tour für neue Nutzer */
  var TOUR_KEY = 'poolsite_tour_done';
  var TOUR_STEPS = [
    { t: 'Willkommen bei PoolSite', b: 'PoolSite ist ein einladungsbasiertes soziales Netzwerk, das seinen Nutzern gehört: Jeden Tag werden 5.000 PST-Token an die Community verteilt. Diese kurze Tour zeigt dir, wie alles zusammenhängt.' },
    { t: 'Der Feed — Aktionen kosten Einsatz', b: 'Posten (0,10 €), Kommentieren (0,05 €) und Reagieren (0,02 €) kosten kleine Beträge aus deinem EUR-Guthaben. Dein Startguthaben: 10 €. Jeder ausgegebene Cent ist unwiderruflich — das nennen wir Burn.' },
    { t: 'Burn wird zu Standing', b: 'Dein Burn geteilt durch deine Aktionen ergibt deine Rate, daraus dein Standing. Liegt es über der Schwelle (Gate offen), zählen deine Reaktionen als Gewicht für andere — Qualität schlägt Masse, Spam bestraft sich selbst.' },
    { t: 'Tägliche Token-Verteilung', b: 'Um 00:00 UTC werden 5.000 PST verteilt: Wer Engagement von Nutzern mit offenem Gate auf seinen Inhalten sammelt, bekommt seinen Anteil. Wurdest du eingeladen, gehen 10 % deiner Token an deine:n Einlader:in.' },
    { t: 'Wallet & sBTC', b: 'Im Wallet siehst du Token, EUR-Credits, Burn, Standing und die heutige Live-Verteilung. Dazu gibt es sBTC (Demo-Bitcoin): täglich per Faucet abholen und gegen Credits verbrennen — kein echtes Geld.' },
    { t: 'Der Markt', b: 'Handle deine PST direkt mit anderen: Verkaufsangebote in EUR-Credits oder sBTC, Kauf ganz oder teilweise, 4 % Plattformgebühr. Der letzte Handelspreis bestimmt die Marktkapitalisierung.' },
    { t: 'Freunde & Einladungen', b: 'Sende Freundschaftsanfragen (auch direkt aus dem Feed) und chatte mit Freunden. Und: Kaufe Einladungslinks (2 €/Platz) — du erhältst dauerhaft 10 % der Token deiner Eingeladenen. Viel Spaß!' }
  ];

  function tourDone() { return localStorage.getItem(TOUR_KEY) === '1'; }

  function startTour() {
    var old = document.getElementById('ps-tour');
    if (old) old.remove();
    var idx = 0;
    var wrap = document.createElement('div');
    wrap.id = 'ps-tour';
    wrap.innerHTML = '<div class="tour-backdrop"></div>' +
      '<div class="tour-card" role="dialog" aria-modal="true">' +
        '<div class="tour-step" id="tour-step">1 / ' + TOUR_STEPS.length + '</div>' +
        '<h2 id="tour-title"></h2>' +
        '<p id="tour-body"></p>' +
        '<div class="tour-dots" id="tour-dots"></div>' +
        '<div class="tour-nav">' +
          '<button class="pill-btn" id="tour-skip">Überspringen</button>' +
          '<span class="appnav-grow"></span>' +
          '<button class="pill-btn" id="tour-prev">Zurück</button>' +
          '<button class="pill-btn primary" id="tour-next">Weiter</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    function close() {
      localStorage.setItem(TOUR_KEY, '1');
      wrap.remove();
    }
    function show() {
      var s = TOUR_STEPS[idx];
      document.getElementById('tour-step').textContent = (idx + 1) + ' / ' + TOUR_STEPS.length;
      document.getElementById('tour-title').textContent = s.t;
      document.getElementById('tour-body').textContent = s.b;
      document.getElementById('tour-prev').style.visibility = idx === 0 ? 'hidden' : 'visible';
      document.getElementById('tour-next').textContent = idx === TOUR_STEPS.length - 1 ? 'Los geht’s' : 'Weiter';
      document.getElementById('tour-dots').innerHTML = TOUR_STEPS.map(function (_, i) {
        return '<span class="' + (i === idx ? 'on' : '') + '"></span>';
      }).join('');
    }
    document.getElementById('tour-skip').onclick = close;
    document.getElementById('tour-prev').onclick = function () { if (idx > 0) { idx--; show(); } };
    document.getElementById('tour-next').onclick = function () {
      if (idx < TOUR_STEPS.length - 1) { idx++; show(); } else { close(); }
    };
    show();
  }

  /* ---------- PWA: Installierbarkeit & Service Worker ---------- */
  var deferredInstall = null;
  function base() { return location.pathname.replace(/[^/]*$/, ''); } // Verzeichnis der aktuellen Seite

  function setupPWA() {
    // Manifest, Theme-Farbe und Apple-Icon in den <head> injizieren (einmalig)
    if (!document.querySelector('link[rel="manifest"]')) {
      var m = document.createElement('link'); m.rel = 'manifest'; m.href = base() + 'manifest.webmanifest';
      document.head.appendChild(m);
    }
    if (!document.querySelector('meta[name="theme-color"]')) {
      var t = document.createElement('meta'); t.name = 'theme-color'; t.content = '#0a1416';
      document.head.appendChild(t);
    }
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      var a = document.createElement('link'); a.rel = 'apple-touch-icon'; a.href = base() + 'assets/icon.svg';
      document.head.appendChild(a);
      var c = document.createElement('meta'); c.name = 'apple-mobile-web-app-capable'; c.content = 'yes';
      document.head.appendChild(c);
    }
    // Service Worker registrieren (nur über HTTPS oder localhost verfügbar)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(base() + 'sw.js').catch(function () {});
    }
    // Installations-Angebot abfangen
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault(); deferredInstall = e;
      document.dispatchEvent(new Event('ps-installable'));
    });
  }
  function canInstall() { return !!deferredInstall; }
  function promptInstall() {
    if (!deferredInstall) return Promise.resolve('unavailable');
    var e = deferredInstall; deferredInstall = null;
    e.prompt();
    return e.userChoice.then(function (r) { return r.outcome; });
  }

  /* ---------- Geräte-Benachrichtigungen ---------- */
  var NOTIF_SEEN_KEY = 'poolsite_notif_seen';
  var notifPoller = null;

  function notificationsSupported() { return 'Notification' in window; }
  function notificationPermission() { return notificationsSupported() ? Notification.permission : 'unsupported'; }
  function enableDeviceNotifications() {
    if (!notificationsSupported()) return Promise.resolve('unsupported');
    return Notification.requestPermission().then(function (p) {
      if (p === 'granted') startNotifPoller();
      return p;
    });
  }

  function showDeviceNotification(text) {
    var opts = { body: text, icon: base() + 'assets/icon.svg', badge: base() + 'assets/icon.svg', data: { url: base() + 'notifications.html' }, tag: 'poolsite' };
    if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(function (reg) { reg.showNotification('PoolSite', opts); }).catch(function () {
        try { new Notification('PoolSite', opts); } catch (e) {}
      });
    } else {
      try { new Notification('PoolSite', opts); } catch (e) {}
    }
  }

  function startNotifPoller() {
    if (mode !== 'server' || notifPoller || notificationPermission() !== 'granted') return;
    notifPoller = setInterval(function () {
      call('/api/notifications').then(function (d) {
        cachedMe = d.me;
        var list = d.notifications || [];
        var seen = localStorage.getItem(NOTIF_SEEN_KEY);
        var newest = list.length ? list[0].id : null;
        // beim allerersten Lauf nur merken, nicht nachträglich alles melden
        if (seen === null) { if (newest) localStorage.setItem(NOTIF_SEEN_KEY, newest); return; }
        if (!newest || newest === seen) return;
        var fresh = [];
        for (var i = 0; i < list.length; i++) { if (list[i].id === seen) break; if (!list[i].read) fresh.push(list[i]); }
        localStorage.setItem(NOTIF_SEEN_KEY, newest);
        if (fresh.length === 1) showDeviceNotification(fresh[0].text);
        else if (fresh.length > 1) showDeviceNotification(fresh.length + ' neue Mitteilungen bei PoolSite');
      }).catch(function () {});
    }, 25000);
  }

  /* Mitteilungen — nur im Live-Modus */
  function notifications() {
    if (mode !== 'server') return Promise.resolve({ local: true, notifications: [] });
    return call('/api/notifications').then(function (d) { cachedMe = d.me; return d; });
  }
  function markNotificationsRead() {
    if (mode !== 'server') return Promise.resolve();
    return call('/api/notifications/read', 'POST', {}).then(function (d) { cachedMe = d.me; });
  }

  /* Einladungen — nur im Live-Modus */
  function invites() {
    if (mode !== 'server') return Promise.resolve({ local: true, invites: [], invitees: [], seatPrice: 2, referralPct: 10 });
    return call('/api/invites');
  }
  function createInvite(seats) {
    if (mode !== 'server') return Promise.reject(new Error('Einladungen gibt es nur im Live-Modus.'));
    return call('/api/invites', 'POST', { seats: seats }).then(function (d) { cachedMe = d.me; return d; });
  }

  /* sBTC (Demo-Bitcoin) — nur im Live-Modus */
  function fmtBtc(n) { return (n || 0).toFixed(8).replace('.', ',') + ' sBTC'; }
  function btcFaucet() {
    if (mode !== 'server') return Promise.reject(new Error('sBTC gibt es nur im Live-Modus.'));
    return call('/api/btc/faucet', 'POST', {}).then(function (d) { cachedMe = d.me; return d.me; });
  }
  function btcBurn(amount) {
    if (mode !== 'server') return Promise.reject(new Error('sBTC gibt es nur im Live-Modus.'));
    return call('/api/btc/burn', 'POST', { amount: amount }).then(function (d) { cachedMe = d.me; return d; });
  }

  /* Markt: Token-Handel zwischen Nutzern — nur im Live-Modus */
  function market() {
    if (mode !== 'server') return Promise.resolve({ local: true, offers: [], trades: [], lastPrice: null });
    return call('/api/market').then(function (d) { cachedMe = d.me; return d; });
  }
  function createOffer(amount, pricePerToken, currency) {
    if (mode !== 'server') return Promise.reject(new Error('Der Markt ist nur im Live-Modus verfügbar.'));
    return call('/api/market/offers', 'POST', { amount: amount, pricePerToken: pricePerToken, currency: currency || 'EUR' }).then(function (d) { cachedMe = d.me; });
  }
  function cancelOffer(id) {
    if (mode !== 'server') return Promise.reject(new Error('Der Markt ist nur im Live-Modus verfügbar.'));
    return call('/api/market/offers/' + id, 'DELETE').then(function (d) { cachedMe = d.me; });
  }
  function buyOffer(id, amount) {
    if (mode !== 'server') return Promise.reject(new Error('Der Markt ist nur im Live-Modus verfügbar.'));
    return call('/api/market/offers/' + id + '/buy', 'POST', { amount: amount }).then(function (d) { cachedMe = d.me; });
  }

  /* Freunde & Chat — nur im Live-Modus */
  var LOCAL_ONLY = 'Freunde & Chat sind nur im Live-Modus (mit Server) verfügbar.';
  function serverOnly(fn) {
    if (mode !== 'server') return Promise.reject(new Error(LOCAL_ONLY));
    return fn();
  }
  function friends() {
    if (mode !== 'server') return Promise.resolve({ local: true, friends: [], requestsIn: [], requestsOut: [] });
    return call('/api/friends');
  }
  function searchUsers(q) { return serverOnly(function () { return call('/api/users?q=' + encodeURIComponent(q)).then(function (d) { return d.users; }); }); }
  function requestFriend(k) { return serverOnly(function () { return call('/api/friends/request', 'POST', { to: k }); }); }
  function acceptFriend(k) { return serverOnly(function () { return call('/api/friends/accept', 'POST', { from: k }); }); }
  function declineFriend(k) { return serverOnly(function () { return call('/api/friends/decline', 'POST', { from: k }); }); }
  function unfriend(k) { return serverOnly(function () { return call('/api/friends/' + k, 'DELETE'); }); }
  function chat(k) { return serverOnly(function () { return call('/api/chat/' + k); }); }
  function sendMessage(k, text) { return serverOnly(function () { return call('/api/chat/' + k, 'POST', { text: text }); }); }

  function posts(opts) {
    opts = opts || {};
    if (mode === 'server') {
      var q = [];
      if (opts.sort) q.push('sort=' + opts.sort);
      if (opts.type && opts.type !== 'all') q.push('type=' + opts.type);
      if (opts.range && opts.range !== 'all') q.push('range=' + opts.range);
      if (opts.friends) q.push('friends=1');
      return call('/api/posts' + (q.length ? '?' + q.join('&') : '')).then(function (d) { return d.posts; });
    }
    // Lokal-Modus: einfache Filter & Sortierung ohne Standing-Gewichtung
    var users = lUsers();
    var list = lPosts().slice();
    if (opts.type === 'image') list = list.filter(function (p) { return p.image; });
    else if (opts.type === 'video') list = list.filter(function (p) { return p.video; });
    else if (opts.type === 'text') list = list.filter(function (p) { return !p.image && !p.video; });
    if (opts.range === 'day') list = list.filter(function (p) { return Date.now() - new Date(p.createdAt) < 86400000; });
    else if (opts.range === 'week') list = list.filter(function (p) { return Date.now() - new Date(p.createdAt) < 7 * 86400000; });
    function score(p) { return (p.likes || []).length - 0.4 * (p.dislikes || []).length + 1.2 * (p.comments || []).length; }
    if (opts.sort === 'top') list.sort(function (a, b) { return score(b) - score(a); });
    else if (opts.sort === 'hot') list.sort(function (a, b) {
      function h(p) { return score(p) / Math.pow((Date.now() - new Date(p.createdAt)) / 3600000 + 2, 1.5); }
      return h(b) - h(a);
    });
    else if (opts.sort === 'discussed') list.sort(function (a, b) { return (b.comments || []).length - (a.comments || []).length; });
    else list.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    return Promise.resolve(list.map(function (p) {
      return Object.assign(lPostPayload(users, p), { score: Math.round(score(p) * 100) / 100 });
    }));
  }

  function addPost(text, image, video) {
    if (mode === 'server') {
      return call('/api/posts', 'POST', { text: text, image: image || null, video: video || null }).then(function (d) { cachedMe = d.me; });
    }
    if (video) return Promise.reject(new Error('Videos gibt es nur im Live-Modus (mit Server).'));
    var pay = lCharge('post');
    if (!pay.ok) return Promise.reject(new Error(pay.error));
    var ps = lPosts();
    ps.push({ id: Date.now() + '_' + Math.random().toString(36).slice(2, 8), author: lSession(), text: text, image: image || null, createdAt: new Date().toISOString(), likes: [], dislikes: [], comments: [] });
    try { lSavePosts(ps); } catch (e) { return Promise.reject(new Error('Lokaler Speicher voll — Bild zu groß für den Demo-Modus.')); }
    cachedMe = lMe(); return Promise.resolve();
  }

  function react(id, kind) {
    if (mode === 'server') {
      return call('/api/posts/' + id + '/react', 'POST', { kind: kind }).then(function (d) { cachedMe = d.me; });
    }
    var ps = lPosts();
    var p = ps.filter(function (x) { return x.id === id; })[0];
    if (!p) return Promise.resolve();
    p.likes = p.likes || []; p.dislikes = p.dislikes || [];
    var list = p[kind];
    var other = kind === 'likes' ? p.dislikes : p.likes;
    var meKey = lSession();
    var i = list.indexOf(meKey);
    if (i >= 0) {
      list.splice(i, 1);
    } else {
      var pay = lCharge(kind === 'likes' ? 'like' : 'dislike');
      if (!pay.ok) return Promise.reject(new Error(pay.error));
      var j = other.indexOf(meKey);
      if (j >= 0) other.splice(j, 1);
      list.push(meKey);
    }
    lSavePosts(ps);
    cachedMe = lMe(); return Promise.resolve();
  }

  function addComment(id, text) {
    if (mode === 'server') {
      return call('/api/posts/' + id + '/comments', 'POST', { text: text }).then(function (d) { cachedMe = d.me; });
    }
    var pay = lCharge('comment');
    if (!pay.ok) return Promise.reject(new Error(pay.error));
    var ps = lPosts();
    var p = ps.filter(function (x) { return x.id === id; })[0];
    if (!p) return Promise.resolve();
    p.comments = p.comments || [];
    p.comments.push({ id: Date.now() + '_' + Math.random().toString(36).slice(2, 6), author: lSession(), text: text, createdAt: new Date().toISOString() });
    lSavePosts(ps);
    cachedMe = lMe(); return Promise.resolve();
  }

  function delComment(postId, commentId) {
    if (mode === 'server') {
      return call('/api/posts/' + postId + '/comments/' + commentId, 'DELETE');
    }
    var ps = lPosts();
    var p = ps.filter(function (x) { return x.id === postId; })[0];
    if (p) {
      p.comments = (p.comments || []).filter(function (c) { return !(c.id === commentId && c.author === lSession()); });
      lSavePosts(ps);
    }
    return Promise.resolve();
  }

  function delPost(id) {
    if (mode === 'server') {
      return call('/api/posts/' + id, 'DELETE');
    }
    lSavePosts(lPosts().filter(function (p) { return !(p.id === id && p.author === lSession()); }));
    return Promise.resolve();
  }

  /* ---------- UI ---------- */
  function renderNav(active) {
    var host = document.getElementById('app-nav');
    if (!host) return;
    var unread = cachedMe ? (cachedMe.unreadNotifications || 0) : 0;
    var tabs = [
      { id: 'profile', label: 'Profil', href: 'app.html' },
      { id: 'wallet', label: 'Wallet', href: 'wallet.html' },
      { id: 'market', label: 'Markt', href: 'market.html' },
      { id: 'feed', label: 'Feed', href: 'feed.html' },
      { id: 'friends', label: 'Freunde', href: 'friends.html' },
      { id: 'notifications', label: 'Mitteilungen', href: 'notifications.html', badge: unread },
      { id: 'stats', label: 'Key Numbers', href: 'stats.html' },
      { id: 'settings', label: 'Einstellungen', href: 'settings.html' }
    ];
    var credits = cachedMe ? cachedMe.credits : 0;
    host.innerHTML = '<div class="wrap appnav-inner">' + tabs.map(function (t) {
      return '<a class="appnav-tab' + (t.id === active ? ' active' : '') + '" href="' + t.href + '">' + t.label +
        (t.badge ? '<span class="nav-badge">' + (t.badge > 9 ? '9+' : t.badge) + '</span>' : '') + '</a>';
    }).join('') + '<span class="appnav-grow"></span>' +
      '<a class="appnav-credits" href="wallet.html" title="Stable-Guthaben">' + fmtEur(credits) + '</a>' +
      '<a class="appnav-post" href="feed.html#neu">＋ Beitrag</a></div>';
    host.style.display = '';
  }

  function modeBanner() {
    var el = document.getElementById('mode-banner');
    if (!el) return;
    if (mode === 'server') {
      el.textContent = '🟢 Live-Modus: Verbunden mit dem PoolSite-Server — Konten und Beiträge sind echt und für alle sichtbar.';
      el.className = 'beta-banner mode-server';
    } else {
      el.textContent = '⚠️ Demo-Modus: Kein Server erreichbar — Konten und Beiträge werden nur lokal in diesem Browser gespeichert.';
      el.className = 'beta-banner';
    }
  }

  return {
    PRICES: PRICES, START_CREDITS: START_CREDITS,
    init: init, getMode: function () { return mode; },
    me: function () { return cachedMe; }, refreshMe: refreshMe,
    register: register, login: login, guest: guest, upgrade: upgrade,
    logout: logout, deleteAccount: deleteAccount, setAvatar: setAvatar,
    claimStart: claimStart, wallet: wallet, stats: stats,
    invites: invites, createInvite: createInvite,
    updateSettings: updateSettings, startTour: startTour, tourDone: tourDone,
    notifications: notifications, markNotificationsRead: markNotificationsRead,
    canInstall: canInstall, promptInstall: promptInstall,
    notificationPermission: notificationPermission, notificationsSupported: notificationsSupported,
    enableDeviceNotifications: enableDeviceNotifications,
    resetRequest: resetRequest, resetConfirm: resetConfirm,
    market: market, createOffer: createOffer, cancelOffer: cancelOffer, buyOffer: buyOffer,
    btcFaucet: btcFaucet, btcBurn: btcBurn, fmtBtc: fmtBtc,
    friends: friends, searchUsers: searchUsers, requestFriend: requestFriend,
    acceptFriend: acceptFriend, declineFriend: declineFriend, unfriend: unfriend,
    chat: chat, sendMessage: sendMessage,
    posts: posts, addPost: addPost, react: react,
    addComment: addComment, delComment: delComment, delPost: delPost,
    fmtEur: fmtEur, avatarHtml: avatarHtml, media: media, escapeHtml: escapeHtml, timeAgo: timeAgo,
    renderNav: renderNav, modeBanner: modeBanner
  };
})();
