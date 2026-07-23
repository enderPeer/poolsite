/* PoolSite Kern — Speicher, Auth, Navigation (Prototyp: alles im localStorage des Browsers) */
var PS = (function () {
  var USERS_KEY = 'poolsite_users';
  var SESSION_KEY = 'poolsite_session';
  var POSTS_KEY = 'poolsite_posts';
  var GUEST_KEY = '__guest';

  function loadUsers() { try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; } catch (e) { return {}; } }
  function saveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }
  function loadPosts() { try { return JSON.parse(localStorage.getItem(POSTS_KEY)) || []; } catch (e) { return []; } }
  function savePosts(p) { localStorage.setItem(POSTS_KEY, JSON.stringify(p)); }

  function sessionKey() { return localStorage.getItem(SESSION_KEY); }
  function setSession(k) { if (k) { localStorage.setItem(SESSION_KEY, k); } else { localStorage.removeItem(SESSION_KEY); } }
  function me() { var s = sessionKey(); return (s && loadUsers()[s]) || null; }
  function isGuest() { return sessionKey() === GUEST_KEY; }

  function hash(str) {
    if (window.crypto && crypto.subtle) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      });
    }
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
    return Promise.resolve('fb_' + h.toString(16));
  }

  /* Stable-Guthaben & bepreiste Aktionen (Demo-Oekonomie nach Revenue-Anchored Closure) */
  var START_CREDITS = 10.00;
  var PRICES = { post: 0.10, comment: 0.05, like: 0.02, dislike: 0.02 };

  function round2(n) { return Math.round(n * 100) / 100; }
  function fmtEur(n) {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  function ensureEcon(rec) {
    if (rec && rec.credits === undefined) {
      rec.credits = START_CREDITS;
      rec.burn = 0;
      rec.actions = 0;
    }
    return rec;
  }

  function econ(rec) {
    if (!rec) return { credits: 0, burn: 0, actions: 0 };
    return {
      credits: rec.credits === undefined ? START_CREDITS : rec.credits,
      burn: rec.burn || 0,
      actions: rec.actions || 0
    };
  }

  function charge(action) {
    var key = sessionKey();
    var users = loadUsers();
    var rec = users[key];
    if (!rec) return { ok: false, error: 'Nicht angemeldet.' };
    ensureEcon(rec);
    var price = PRICES[action] || 0;
    if (rec.credits + 1e-9 < price) {
      return { ok: false, error: 'Nicht genug Guthaben — diese Aktion kostet ' + fmtEur(price) + '.' };
    }
    rec.credits = round2(rec.credits - price);
    rec.burn = round2(rec.burn + price);
    rec.actions += 1;
    saveUsers(users);
    return { ok: true, price: price, credits: rec.credits };
  }

  function topUp(amount) {
    var users = loadUsers();
    var rec = users[sessionKey()];
    if (!rec) return;
    ensureEcon(rec);
    rec.credits = round2(rec.credits + amount);
    saveUsers(users);
  }

  function guestLogin() {
    var users = loadUsers();
    if (!users[GUEST_KEY]) {
      users[GUEST_KEY] = {
        name: 'Gast', guest: true, passHash: null, email: null,
        notifyConsent: false, createdAt: new Date().toISOString(), avatar: null
      };
      saveUsers(users);
    }
    setSession(GUEST_KEY);
  }

  function avatarHtml(rec) {
    if (rec && rec.avatar) { return '<img src="' + rec.avatar + '" alt="">'; }
    var ch = rec && rec.name ? rec.name.charAt(0).toUpperCase() : '?';
    return '<span>' + ch + '</span>';
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

  function renderNav(active) {
    var host = document.getElementById('app-nav');
    if (!host) return;
    var tabs = [
      { id: 'profile', label: '👤 Profil', href: 'app.html' },
      { id: 'wallet', label: '💰 Wallet', href: 'wallet.html' },
      { id: 'feed', label: '📰 Newsfeed', href: 'feed.html' }
    ];
    var e = econ(me());
    host.innerHTML = '<div class="wrap appnav-inner">' + tabs.map(function (t) {
      return '<a class="appnav-tab' + (t.id === active ? ' active' : '') + '" href="' + t.href + '">' + t.label + '</a>';
    }).join('') + '<span class="appnav-grow"></span>' +
      '<a class="appnav-credits" href="wallet.html" title="Stable-Guthaben">💶 ' + fmtEur(e.credits) + '</a>' +
      '<a class="appnav-post" href="feed.html#neu">＋ Beitrag</a></div>';
    host.style.display = '';
  }

  return {
    GUEST_KEY: GUEST_KEY,
    PRICES: PRICES, START_CREDITS: START_CREDITS,
    loadUsers: loadUsers, saveUsers: saveUsers,
    loadPosts: loadPosts, savePosts: savePosts,
    sessionKey: sessionKey, setSession: setSession,
    me: me, isGuest: isGuest,
    hash: hash, guestLogin: guestLogin,
    econ: econ, charge: charge, topUp: topUp, fmtEur: fmtEur,
    avatarHtml: avatarHtml, escapeHtml: escapeHtml, timeAgo: timeAgo,
    renderNav: renderNav
  };
})();
