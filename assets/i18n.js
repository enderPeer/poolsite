/* PoolSite i18n — Deutsch (Quellsprache) ↔ Englisch.
   Ansatz: exakte Textknoten-Übersetzung per Wörterbuch + Regex-Regeln für dynamische
   Muster (Zeitangaben, Beträge, Servermeldungen). Ein MutationObserver übersetzt auch
   nachträglich gerenderte Inhalte (Feed, Navigation, Overlays) automatisch. */
var PSI18N = (function () {
  var KEY = 'poolsite_lang';

  function lang() {
    var stored = localStorage.getItem(KEY);
    if (stored === 'de' || stored === 'en') return stored;
    return (navigator.language || 'de').toLowerCase().indexOf('de') === 0 ? 'de' : 'en';
  }
  function setLang(l) { localStorage.setItem(KEY, l === 'en' ? 'en' : 'de'); location.reload(); }
  function toggle() { setLang(lang() === 'en' ? 'de' : 'en'); }

  /* ---------- Wörterbuch: exakte Strings ---------- */
  var D = {
    /* Navigation & global */
    'Profil': 'Profile', 'Wallet': 'Wallet', 'Markt': 'Market', 'Feed': 'Feed',
    'Freunde': 'Friends', 'Mitteilungen': 'Notifications', 'Key Numbers': 'Key Numbers',
    'Einstellungen': 'Settings', '＋ Beitrag': '＋ Post',
    '← Zurück zur Website': '← Back to website', '← Zurück zu Freunden': '← Back to friends',
    'Verbinde…': 'Connecting…',
    '🟢 Live-Modus: Verbunden mit dem PoolSite-Server — Konten und Beiträge sind echt und für alle sichtbar.':
      '🟢 Live mode: Connected to the PoolSite server — accounts and posts are real and visible to everyone.',
    '⚠️ Demo-Modus: Kein Server erreichbar — Konten und Beiträge werden nur lokal in diesem Browser gespeichert.':
      '⚠️ Demo mode: No server reachable — accounts and posts are stored only locally in this browser.',

    /* Landingpage */
    'Konzept': 'Concept', 'Tokenomics': 'Tokenomics', 'Erlösmodell': 'Revenue model', 'Roadmap': 'Roadmap',
    'App →': 'App →', 'Zur App →': 'Open the app →',
    'Tokenisierte Unternehmensanteile · powered by tokenize.it': 'Tokenized company shares · powered by tokenize.it',
    'Das soziale Netzwerk,': 'The social network',
    'seinen Nutzern gehört': 'owned by its users', 'das': 'that is',
    'PoolSite — Das soziale Netzwerk, das seinen Nutzern gehört': 'PoolSite — The social network owned by its users',
    'PoolSite verteilt echte Unternehmensanteile — als Token — täglich an seine aktiven Nutzer. Wer das Netzwerk mit aufbaut, wird Miteigentümer und profitiert direkt von den Einnahmen.':
      'PoolSite distributes real company shares — as tokens — to its active users every day. Those who help build the network become co-owners and share in the revenue directly.',
    'Token = 100 % der Anteile': 'tokens = 100% of all shares',
    'Token pro Tag, −10 % p. a.': 'tokens per day, −10% p.a.',
    'tägliche Verteilung': 'daily distribution',
    'Konto erstellen →': 'Create account →', "So funktioniert's": 'How it works',
    'Einladung anfordern': 'Request an invite',
    'Das Konzept': 'The concept',
    'Nutzer bauen das Netzwerk auf — und besitzen es': 'Users build the network — and own it',
    'Aktiv sein & Punkte sammeln': 'Be active & earn points',
    'Beiträge, Interaktionen und Engagement im Netzwerk werden über ein transparentes Punktesystem bewertet.':
      'Posts, interactions and engagement are scored through a transparent points system.',
    'Täglich Token erhalten': 'Receive tokens daily',
    'Jeden Tag wird ein festes Token-Kontingent anteilig nach Punkten an alle aktiven Nutzer verteilt — im ersten Jahr 5.000 Token pro Tag.':
      'Every day a fixed token budget is distributed proportionally by points — 5,000 tokens per day in year one.',
    'Miteigentümer werden': 'Become a co-owner',
    'Jeder Token repräsentiert einen echten Anteil an der Gesellschaft. Token-Halter partizipieren an Gewinnausschüttungen.':
      'Each token represents a real share of the company. Token holders participate in profit distributions.',
    '18,25 Millionen Token. Mathematisch begrenzt.': '18.25 million tokens. Mathematically capped.',
    'Zugang': 'Access',
    'PoolSite ist einladungsbasiert': 'PoolSite is invite-only',
    'Einladung per E-Mail anfordern': 'Request an invite by email',
    'Erst mal als Gast umsehen': 'Look around as a guest first',
    'Das Punktesystem': 'The points system',
    'So werden die 5.000 Token pro Tag verteilt': 'How the 5,000 daily tokens are distributed',

    /* Auth */
    'Willkommen bei PoolSite': 'Welcome to PoolSite',
    'Melde dich an oder erstelle dein Konto.': 'Sign in or create your account.',
    'Anmelden': 'Sign in', 'Registrieren': 'Register',
    'Nutzername': 'Username', 'Passwort': 'Password',
    'Einladungscode': 'Invite code',
    'Mindestens 4 Zeichen.': 'At least 4 characters.',
    'oder': 'or',
    'Als Gast umsehen →': 'Browse as guest →',
    'Kein Konto nötig — du kannst den Gast-Zugang später jederzeit in ein echtes Konto umwandeln.':
      'No account needed — you can convert guest access into a full account anytime.',
    'Passwort vergessen?': 'Forgot password?',
    'Passwort zurücksetzen': 'Reset password',
    'Nur möglich, wenn dein Konto eine E-Mail-Adresse hinterlegt hat.': 'Only possible if your account has an email on file.',
    'Hinterlegte E-Mail': 'Email on file',
    'Code anfordern': 'Request code',
    'Code aus der E-Mail': 'Code from the email',
    'Neues Passwort': 'New password', 'Passwort setzen': 'Set password',
    '← Zurück zur Anmeldung': '← Back to sign-in',
    'Konto erstellen': 'Create account',

    /* Profil */
    'Dein PoolSite-Profil': 'Your PoolSite profile',
    'Gastmodus — Konto noch nicht gesichert': 'Guest mode — account not saved yet',
    'Gastmodus aktiv': 'Guest mode active',
    'Konto übernehmen': 'Claim account',
    'E-Mail': 'Email', 'Passwort-Reset': 'Password reset',
    'Mitglied seit': 'Member since',
    'Stable-Guthaben (EUR)': 'Stable balance (EUR)',
    'Burn (Commitment B)': 'Burn (commitment B)',
    'Token-Guthaben': 'Token balance',
    'hinterlegt — nicht im Klartext gespeichert': 'on file — never stored in plain text',
    'nicht angegeben': 'not provided',
    'möglich': 'available', 'nicht möglich': 'not available',
    'Einladungen': 'Invites',
    'Link kopieren': 'Copy link',
    'Wallet öffnen →': 'Open wallet →',
    'Abmelden': 'Sign out', 'Konto löschen': 'Delete account', 'Gast-Daten löschen': 'Delete guest data',
    'Gast (ohne Konto)': 'Guest (no account)',

    /* Feed */
    'Newsfeed': 'News feed',
    'Teile Neuigkeiten mit der Community. Bezahlte Aktionen erhöhen deinen Burn (Commitment B) und damit dein Standing.':
      'Share news with the community. Paid actions increase your burn (commitment B) and with it your standing.',
    "Was gibt's Neues?": "What's new?",
    'Posten': 'Post', 'Bild': 'Image', 'Video 7s': 'Video 7s',
    'Neu': 'New', 'Heiß': 'Hot', 'Top': 'Top', 'Diskutiert': 'Discussed',
    'Alle Typen': 'All types', 'Nur Text': 'Text only', 'Nur Bilder': 'Images only', 'Nur Videos': 'Videos only',
    'Gesamter Zeitraum': 'All time', 'Letzte 24 h': 'Last 24 h', 'Letzte Woche': 'Last week',
    'Nur Freunde': 'Friends only',
    'Senden': 'Send',
    'Noch keine Beiträge. Sei die erste Stimme im Feed! 🚀': 'No posts yet. Be the first voice in the feed! 🚀',
    '＋ Freund': '＋ Friend', 'Annehmen': 'Accept', 'Chat': 'Chat',
    'Lade Feed…': 'Loading feed…', 'Lade…': 'Loading…',

    /* Wallet */
    'Hallo': 'Hello', ', hier ist dein Token-Überblick.': ', here is your token overview.',
    'Token-Guthaben (PST)': 'Token balance (PST)',
    'Stable-Guthaben (EUR-Credits)': 'Stable balance (EUR credits)',
    'Referral-Einnahmen': 'Referral earnings',
    '10 % der Token deiner Eingeladenen — Links gibt es im Profil.': '10% of your invitees’ tokens — get links in your profile.',
    'Heutige Verteilung — läuft live': 'Today’s distribution — running live',
    'Dein Gewicht heute': 'Your weight today',
    'Netzwerk-Gewicht heute': 'Network weight today',
    'Dein voraussichtlicher Anteil': 'Your projected share',
    'Nächste Verteilung (00:00 UTC)': 'Next distribution (00:00 UTC)',
    'Dein Standing — das Punktesystem': 'Your standing — the points system',
    'Dein Burn (Commitment B)': 'Your burn (commitment B)',
    'Aktionen (N)': 'Actions (N)',
    'Rate (r = B ÷ N)': 'Rate (r = B ÷ N)',
    'Standing (α̂) & Gate (Schwelle ρ = 0,2)': 'Standing (α̂) & gate (threshold ρ = 0.2)',
    'Deine Token pro Tag': 'Your tokens per day',
    'Echte tägliche Ausschüttungen an dich — letzte 30 Tage': 'Real daily distributions to you — last 30 days',
    'Token im Umlauf (echt verteilt, von 18,25 Mio.)': 'Tokens in circulation (actually distributed, of 18.25M)',
    'Übertrag (Carryover) aus Tagen ohne Gewicht': 'Carryover from days without weight',
    'Preis pro Token (letzter Handel)': 'Price per token (last trade)',
    'Preis pro Token (noch kein Handel)': 'Price per token (no trades yet)',
    'Marktkapitalisierung (Umlauf × Preis)': 'Market cap (circulation × price)',
    'Bitcoin (Demo) — sBTC verbrennen für Credits': 'Bitcoin (demo) — burn sBTC for credits',
    'Dein sBTC-Guthaben': 'Your sBTC balance',
    'Demo-Faucet — einmal täglich': 'Demo faucet — once a day',
    '0,0002 sBTC abholen': 'Claim 0.0002 sBTC',
    'Verbrennen → €': 'Burn → €',
    'Gestern erhalten:': 'Received yesterday:',
    'Burn gesamt:': 'Total burn:',

    /* Markt */
    'Letzter Preis pro Token (€-Gegenwert)': 'Last price per token (€ equivalent)',
    'Deine Token (frei)': 'Your tokens (free)',
    'Deine EUR-Credits': 'Your EUR credits',
    'Dein sBTC (Demo)': 'Your sBTC (demo)',
    'Token verkaufen': 'Sell tokens',
    'Menge (PST)': 'Amount (PST)', 'Währung': 'Currency',
    'EUR-Credits': 'EUR credits', 'sBTC (Demo)': 'sBTC (demo)',
    'Angebot einstellen': 'Create offer',
    'Offene Angebote': 'Open offers',
    'Letzte Trades': 'Recent trades',
    'Noch keine Trades.': 'No trades yet.',
    'Keine offenen Angebote — stelle das erste ein!': 'No open offers — create the first one!',
    'Kaufen': 'Buy', 'Zurückziehen': 'Withdraw',
    'Nur zum Zusehen': 'View only',
    'Nur mit Einladung': 'Invite required',
    '(dein Angebot)': '(your offer)',

    /* Freunde & Chat */
    'Finde Nutzer, sende Anfragen — und chatte mit deinen Freunden.': 'Find users, send requests — and chat with your friends.',
    'Nutzer finden': 'Find users',
    'Suchen': 'Search',
    'Anfragen an dich': 'Requests for you',
    'Deine Freunde': 'Your friends',
    'Gesendete Anfragen': 'Sent requests',
    'Ablehnen': 'Decline',
    'Wartet…': 'Pending…', 'Angefragt ✓': 'Requested ✓',
    'Keine Nutzer gefunden.': 'No users found.',
    'Noch keine Freunde — such oben nach Nutzern und sende eine Anfrage!': 'No friends yet — search above and send a request!',
    'Gast-Konto': 'Guest account',
    'Nachricht schreiben…': 'Write a message…',
    'Betrag (PST)': 'Amount (PST)', 'Abbrechen': 'Cancel',
    'Bitte wähle eine GIF-Datei aus.': 'Please choose a GIF file.',
    'GIF zu groß (max. 1,5 MB).': 'GIF too large (max 1.5 MB).',
    'Gäste können keine Token senden.': 'Guests cannot send tokens.',
    'Gäste können keine Token empfangen.': 'Guests cannot receive tokens.',
    'Mindestbetrag: 0,01 PST.': 'Minimum amount: 0.01 PST.',
    'Noch keine Nachrichten — schreib die erste! 👋': 'No messages yet — write the first one! 👋',
    'Lade Chat…': 'Loading chat…',

    /* Mitteilungen */
    'Deine Timeline — was seit deinem letzten Besuch passiert ist.': 'Your timeline — what happened since your last visit.',
    'Heute': 'Today', 'Gestern': 'Yesterday',
    'Noch keine Mitteilungen — sie erscheinen, sobald etwas passiert: Likes, Kommentare, Freunde, Trades, Token.':
      'No notifications yet — they appear as things happen: likes, comments, friends, trades, tokens.',
    'Like': 'Like', 'Dislike': 'Dislike', 'Kommentar': 'Comment', 'Anfrage': 'Request',
    'Handel': 'Trade', 'Token': 'Tokens', 'Einladung': 'Invite',

    /* Key Numbers */
    'Die wichtigsten Kennzahlen des Netzwerks — live aus der Datenbank.': 'The network’s key figures — live from the database.',
    'Gesamt': 'Totals',
    'Registrierte Nutzer': 'Registered users', 'Gast-Konten': 'Guest accounts',
    'Aktive Nutzer heute': 'Active users today', 'Startguthaben abgeholt': 'Start credits claimed',
    'Beiträge': 'Posts', 'Kommentare': 'Comments', 'Reaktionen (👍 + 👎)': 'Reactions (👍 + 👎)',
    'Burn gesamt (Commitment)': 'Total burn (commitment)',
    'Token verteilt (PST)': 'Tokens distributed (PST)', 'Carryover (PST)': 'Carryover (PST)',
    'Credits im System (EUR)': 'Credits in the system (EUR)', 'Logins heute': 'Logins today',
    'Tägliche Aktivitäten': 'Daily activity',
    'Logins & neue Konten': 'Logins & new accounts',
    'Burn pro Tag': 'Burn per day',
    'Logins': 'Logins', 'Registrierungen': 'Registrations', 'Gäste': 'Guests',

    /* Einstellungen */
    'Konto, Benachrichtigungen und Hilfe.': 'Account, notifications and help.',
    'App installieren': 'Install app',
    'Geräte-Benachrichtigungen': 'Device notifications',
    'Benachrichtigungen aktivieren': 'Enable notifications',
    'Benachrichtigungen aktiv ✓': 'Notifications active ✓',
    'Im Browser blockiert': 'Blocked by browser',
    'Walkthrough': 'Walkthrough', 'Walkthrough starten': 'Start walkthrough',
    'E-Mail für den Passwort-Reset': 'Email for password reset',
    'Speichern': 'Save',
    'Passwort ändern': 'Change password',
    'Aktuelles Passwort': 'Current password',
    'Konto': 'Account',
    'Sprache': 'Language',

    /* Walkthrough (Tour) — Titel & Inhalte */
    'Überspringen': 'Skip', 'Zurück': 'Back', 'Weiter': 'Next', 'Los geht’s': 'Let’s go',
    'Der Feed — Aktionen kosten Einsatz': 'The feed — actions cost stake',
    'Burn wird zu Standing': 'Burn becomes standing',
    'Tägliche Token-Verteilung': 'Daily token distribution',
    'Wallet & sBTC': 'Wallet & sBTC',
    'Der Markt': 'The market',
    'Freunde & Einladungen': 'Friends & invites',
    'PoolSite ist ein einladungsbasiertes soziales Netzwerk, das seinen Nutzern gehört: Jeden Tag werden 5.000 PST-Token an die Community verteilt. Diese kurze Tour zeigt dir, wie alles zusammenhängt.':
      'PoolSite is an invite-only social network owned by its users: every day, 5,000 PST tokens are distributed to the community. This short tour shows you how it all fits together.',
    'Posten (0,10 €), Kommentieren (0,05 €) und Reagieren (0,02 €) kosten kleine Beträge aus deinem EUR-Guthaben. Dein Startguthaben: 10 €. Jeder ausgegebene Cent ist unwiderruflich — das nennen wir Burn.':
      'Posting (€0.10), commenting (€0.05) and reacting (€0.02) cost small amounts from your EUR balance. Your starting balance: €10. Every cent spent is irreversible — we call that burn.',
    'Dein Burn geteilt durch deine Aktionen ergibt deine Rate, daraus dein Standing. Liegt es über der Schwelle (Gate offen), zählen deine Reaktionen als Gewicht für andere — Qualität schlägt Masse, Spam bestraft sich selbst.':
      'Your burn divided by your actions gives your rate, and from that your standing. Above the threshold (gate open), your reactions count as weight for others — quality beats volume, spam taxes itself.',
    'Um 00:00 UTC werden 5.000 PST verteilt: Wer Engagement von Nutzern mit offenem Gate auf seinen Inhalten sammelt, bekommt seinen Anteil. Wurdest du eingeladen, gehen 10 % deiner Token an deine:n Einlader:in.':
      'At 00:00 UTC, 5,000 PST are distributed: whoever collects engagement from gate-open users on their content gets their share. If you were invited, 10% of your tokens go to your inviter.',
    'Im Wallet siehst du Token, EUR-Credits, Burn, Standing und die heutige Live-Verteilung. Dazu gibt es sBTC (Demo-Bitcoin): täglich per Faucet abholen und gegen Credits verbrennen — kein echtes Geld.':
      'The wallet shows tokens, EUR credits, burn, standing and today’s live distribution. There is also sBTC (demo Bitcoin): claim it daily from the faucet and burn it for credits — no real money.',
    'Handle deine PST direkt mit anderen: Verkaufsangebote in EUR-Credits oder sBTC, Kauf ganz oder teilweise, 4 % Plattformgebühr. Der letzte Handelspreis bestimmt die Marktkapitalisierung.':
      'Trade your PST directly with others: sell offers in EUR credits or sBTC, buy in full or partially, 4% platform fee. The last trade price sets the market cap.',
    'Sende Freundschaftsanfragen (auch direkt aus dem Feed) und chatte mit Freunden. Und: Kaufe Einladungslinks (2 €/Platz) — du erhältst dauerhaft 10 % der Token deiner Eingeladenen. Viel Spaß!':
      'Send friend requests (also straight from the feed) and chat with friends. And: buy invite links (€2/seat) — you permanently earn 10% of your invitees’ tokens. Have fun!',

    /* Wallet & Einstellungen — JS-generierte Texte */
    'Dein Gate ist offen: Deine Interaktionen geben anderen Gewicht — und Engagement auf deinen Inhalten bringt dir Anteile an der täglichen Verteilung. Jede Aktion ohne Einsatz senkt deine Rate.':
      'Your gate is open: your interactions give weight to others — and engagement on your content earns you a share of the daily distribution. Every action without stake lowers your rate.',
    'Noch keine Aktionen: Poste, kommentiere oder like im Newsfeed — jede bezahlte Aktion erhöht deinen Burn und baut dein Standing auf.':
      'No actions yet: post, comment or like in the feed — every paid action increases your burn and builds your standing.',
    'Noch keine Ausschüttung erhalten. Sammle heute Gewicht — die erste Verteilung kommt um 00:00 UTC.':
      'No distribution received yet. Collect weight today — the first distribution arrives at 00:00 UTC.',
    'läuft…': 'running…', 'nur im Live-Modus': 'live mode only',
    'PoolSite ist bereits als App installiert. ✓': 'PoolSite is already installed as an app. ✓',
    'hinterlegt ✓ (als Fingerabdruck, Reset möglich)': 'on file ✓ (as fingerprint, reset possible)',
    'keine E-Mail hinterlegt — Passwort-Reset nicht möglich': 'no email on file — password reset not possible',
    'Nur für volle Konten — als Gast kannst du hier nur zusehen. Lass dich einladen, um mitzumachen.':
      'Full accounts only — as a guest you can only watch. Get invited to participate.',
    'Als Gast kannst du den Markt ansehen, aber nicht handeln. Lass dich von einem Mitglied einladen, um Token zu kaufen und zu verkaufen.':
      'As a guest you can view the market but not trade. Get invited by a member to buy and sell tokens.',

    /* Häufige Meldungen (Client) */
    'Schreib etwas oder füge ein Bild/Video hinzu.': 'Write something or add an image/video.',
    'Link kopiert:': 'Link copied:',
    'Gespeichert. ✓': 'Saved. ✓',
    'Passwort geändert. ✓': 'Password changed. ✓',
    'Profilbild aktualisiert. ✓': 'Profile picture updated. ✓'
  };

  /* ---------- Regex-Regeln für dynamische Muster ---------- */
  var R = [
    [/^gerade eben$/, 'just now'],
    [/vor (\d+) Min\./g, '$1 min ago'],
    [/vor (\d+) Std\./g, '$1 h ago'],
    [/vor (\d+) Tagen/g, '$1 days ago'],
    [/vor (\d+) Tag/g, '$1 day ago'],
    [/^(\d+) \/ 7$/, '$1 / 7'],
    [/Nicht genug Guthaben — diese Aktion kostet (.+)\.$/, 'Insufficient balance — this action costs $1.'],
    [/^Beitrag veröffentlicht — (.+) Burn → Commitment B\. ✓$/, 'Post published — $1 burn → commitment B. ✓'],
    [/^Falls Nutzername und E-Mail zusammenpassen, wurde ein Code verschickt \(15 Minuten gültig\)\.$/,
      'If username and email match, a code has been sent (valid for 15 minutes).'],
    [/^Nutzername oder Passwort ist falsch\.$/, 'Wrong username or password.'],
    [/^Dieser Nutzername ist bereits vergeben\.$/, 'This username is already taken.'],
    [/^Registrierung nur mit gültigem Einladungscode möglich\..*$/, 'Registration requires a valid invite code. Ask a member for an invite.'],
    [/gefällt dein Beitrag/g, 'likes your post'],
    [/hat deinen Beitrag gedislikt/g, 'disliked your post'],
    [/hat kommentiert:/g, 'commented:'],
    [/hat dir eine Freundschaftsanfrage geschickt\./g, 'sent you a friend request.'],
    [/hat deine Freundschaftsanfrage angenommen\./g, 'accepted your friend request.'],
    [/und du seid jetzt befreundet\./g, 'and you are now friends.'],
    [/^Neue Nachricht von (.+)\.$/, 'New message from $1.'],
    [/^Du hast (.+) PST gesendet$/, 'You sent $1 PST'],
    [/^\+(.+) PST erhalten$/, '+$1 PST received'],
    [/hat dir (.+) PST geschickt\./g, 'sent you $1 PST.'],
    [/^Verfügbar: (.+) PST$/, 'Available: $1 PST'],
    [/^Nicht genug Token — du hast (.+) PST\.$/, 'Not enough tokens — you have $1 PST.'],
    [/ist über deine Einladung beigetreten\./g, 'joined via your invite.'],
    [/^Tagesverteilung (.+): \+(.+) PST für dein Engagement\.$/, 'Daily distribution $1: +$2 PST for your engagement.'],
    [/^Referral: \+(.+) PST von (.+) \(Verteilung (.+)\)\.$/, 'Referral: +$1 PST from $2 (distribution $3).'],
    [/hat (\d+) PST aus deinem Angebot gekauft/g, 'bought $1 PST from your offer'],
    [/erhalten, abzgl\. Gebühr\)\./g, 'received, net of fee).'],
    [/· Score /g, ' · score '],
    [/(\d+) \/ (\d+) Plätze genutzt/g, '$1 / $2 seats used'],
    [/— voll$/, '— full']
  ];

  function translateString(s) {
    var trimmed = s.trim();
    if (!trimmed) return null;
    if (D.hasOwnProperty(trimmed)) {
      var res = s.replace(trimmed, D[trimmed]);
      return res !== s ? res : null; // Identitäts-Übersetzungen nie zurückgeben (sonst Observer-Schleife)
    }
    var out = s, hit = false;
    for (var i = 0; i < R.length; i++) {
      if (R[i][0].test(out)) { out = out.replace(R[i][0], R[i][1]); hit = true; }
      if (R[i][0].global) R[i][0].lastIndex = 0;
    }
    return (hit && out !== s) ? out : null;
  }

  var ATTRS = ['placeholder', 'title', 'aria-label'];
  function walk(root) {
    if (lang() !== 'en') return;
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = tw.nextNode())) {
      var p = n.parentNode && n.parentNode.nodeName;
      if (p === 'SCRIPT' || p === 'STYLE') continue;
      var t = translateString(n.nodeValue);
      if (t !== null && t !== n.nodeValue) n.nodeValue = t;
    }
    var els = root.querySelectorAll ? root.querySelectorAll('[placeholder],[title],[aria-label],input[type=submit],option') : [];
    for (var i = 0; i < els.length; i++) {
      for (var a = 0; a < ATTRS.length; a++) {
        var v = els[i].getAttribute(ATTRS[a]);
        if (v) { var tv = translateString(v); if (tv !== null) els[i].setAttribute(ATTRS[a], tv); }
      }
    }
  }

  var observing = false;
  function apply() {
    document.documentElement.lang = lang();
    if (lang() !== 'en') return;
    walk(document.body);
    if (document.title) { var tt = translateString(document.title); if (tt) document.title = tt; }
    if (!observing) {
      observing = true;
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          for (var j = 0; j < muts[i].addedNodes.length; j++) {
            var node = muts[i].addedNodes[j];
            if (node.nodeType === 1) walk(node);
            else if (node.nodeType === 3) { var t = translateString(node.nodeValue); if (t !== null && t !== node.nodeValue) node.nodeValue = t; }
          }
          if (muts[i].type === 'characterData') {
            var t2 = translateString(muts[i].target.nodeValue);
            if (t2 !== null && t2 !== muts[i].target.nodeValue) muts[i].target.nodeValue = t2;
          }
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  document.addEventListener('DOMContentLoaded', apply);

  return { lang: lang, setLang: setLang, toggle: toggle, apply: apply, t: translateString };
})();
