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
  function avatarHtml(who) {
    if (who && who.avatar) { return '<img src="' + who.avatar + '" alt="">'; }
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
      key: k, name: rec.name, email: rec.email || null, notifyConsent: !!rec.notifyConsent,
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
      id: p.id, text: p.text, image: p.image || null, createdAt: p.createdAt,
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

    return fetch(apiBase + '/api/health', { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.mode === 'server') { mode = 'server'; return refreshMe(); }
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

  function register(name, pass, email) {
    if (mode === 'server') {
      return call('/api/register', 'POST', { username: name, password: pass, email: email }).then(function (d) {
        localStorage.setItem(TOKEN_KEY, d.token); cachedMe = d.me; return d.me;
      });
    }
    var err = lValidate(name, pass);
    if (err) return Promise.reject(new Error(err));
    var k = name.toLowerCase();
    return hashStr(k + ':' + pass).then(function (ph) {
      var users = lUsers();
      users[k] = { name: name, passHash: ph, email: email || null, notifyConsent: !!email, createdAt: new Date().toISOString(), avatar: null, credits: 0, burn: 0, actions: 0, tokens: 0, startClaimed: false };
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

  function upgrade(name, pass, email) {
    if (mode === 'server') {
      return call('/api/upgrade', 'POST', { username: name, password: pass, email: email }).then(function (d) {
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

  function posts() {
    if (mode === 'server') {
      return call('/api/posts').then(function (d) { return d.posts; });
    }
    var users = lUsers();
    return Promise.resolve(
      lPosts().slice().sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); })
        .map(function (p) { return lPostPayload(users, p); })
    );
  }

  function addPost(text, image) {
    if (mode === 'server') {
      return call('/api/posts', 'POST', { text: text, image: image || null }).then(function (d) { cachedMe = d.me; });
    }
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
    var tabs = [
      { id: 'profile', label: '👤 Profil', href: 'app.html' },
      { id: 'wallet', label: '💰 Wallet', href: 'wallet.html' },
      { id: 'feed', label: '📰 Newsfeed', href: 'feed.html' },
      { id: 'friends', label: '👥 Freunde', href: 'friends.html' },
      { id: 'stats', label: '📊 Key Numbers', href: 'stats.html' }
    ];
    var credits = cachedMe ? cachedMe.credits : 0;
    host.innerHTML = '<div class="wrap appnav-inner">' + tabs.map(function (t) {
      return '<a class="appnav-tab' + (t.id === active ? ' active' : '') + '" href="' + t.href + '">' + t.label + '</a>';
    }).join('') + '<span class="appnav-grow"></span>' +
      '<a class="appnav-credits" href="wallet.html" title="Stable-Guthaben">💶 ' + fmtEur(credits) + '</a>' +
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
    friends: friends, searchUsers: searchUsers, requestFriend: requestFriend,
    acceptFriend: acceptFriend, declineFriend: declineFriend, unfriend: unfriend,
    chat: chat, sendMessage: sendMessage,
    posts: posts, addPost: addPost, react: react,
    addComment: addComment, delComment: delComment, delPost: delPost,
    fmtEur: fmtEur, avatarHtml: avatarHtml, escapeHtml: escapeHtml, timeAgo: timeAgo,
    renderNav: renderNav, modeBanner: modeBanner
  };
})();
