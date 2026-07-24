# PoolSite — Wie die Plattform gebaut wurde

Einladungsbasiertes soziales Netzwerk mit Token-Ökonomie. Dieses Dokument beschreibt
Architektur, Ökonomie-Regeln, Betrieb und Wartung — genug, um die Plattform von Grund
auf zu verstehen, zu betreiben oder nachzubauen.

Live: Landingpage auf GitHub Pages (`https://enderpeer.github.io/poolsite/`),
App auf einem Heim-PC hinter einem kostenlosen Cloudflare-Quick-Tunnel.

---

## 1. Architektur-Überblick

Bewusst einfacher Stack — **keine einzige npm-Abhängigkeit**:

```
Browser (Vanilla JS, kein Framework)
   │  fetch + Bearer-Token
   ▼
server.js — ein einzelner Node.js-Prozess (~1.100 Zeilen)
   ├── Statische Dateien (HTML/CSS/JS aus dem Projektordner)
   ├── REST-API unter /api/*
   ├── /media/* → hochgeladene Videos aus data/media/
   ├── Tages-Jobs (Token-Verteilung, Backups) via setInterval
   └── SMTP-Client (TLS, AUTH LOGIN) für Passwort-Reset-Mails
   ▼
data/ (gitignored)
   ├── db.json          JSON-Datenbank: Nutzer, Posts, Markt, Chat, Einladungen, Statistik
   ├── media/           Videos als Dateien (nicht in der DB)
   ├── secret.key       Salt für E-Mail-Fingerabdrücke
   └── mail-config.json SMTP-Zugangsdaten (Gmail-App-Passwort)
```

**Öffentlich erreichbar** über `cloudflared tunnel --url http://localhost:3000`
(TryCloudflare: kostenlos, kein Account, aber die URL wechselt bei jedem Neustart).
Die **stabile** URL ist die GitHub-Pages-Landingpage; ihre App-Buttons tragen
`?api=<tunnel-url>` und verbinden Besucher so mit dem Live-Server.

**Dual-Modus-Frontend** (`assets/app-core.js`): beim Laden wird `/api/health` geprüft.
Antwortet der Server → „Live-Modus" (grüner Banner, geteilte Daten). Sonst → „Demo-Modus"
(gelber Banner, localStorage nur im eigenen Browser). Dadurch bleibt die GitHub-Pages-Kopie
ohne Server funktionsfähig.

## 2. Dateien

| Datei | Zweck |
|---|---|
| `server.js` | Kompletter Server: statische Dateien, API, Ökonomie, Verteilung, SMTP |
| `backup.js` | Backup/Restore-Werkzeug, wird vom Server automatisch mitgenutzt |
| `index.html` | Landingpage/Explainer (Tokenomics, Punktesystem, Zugang) — eigenes CSS inline |
| `app.html` | Login, Registrierung (nur mit Einladungscode), Gast-Zugang, Profil, Einladungsverwaltung, Passwort-vergessen |
| `feed.html` | Newsfeed: Posts (Text/Bild/Video), Reaktionen, Kommentare, Filter/Sortierung, Freundschafts-Buttons |
| `wallet.html` | Token-/EUR-/sBTC-Guthaben, Standing Card, Live-Verteilung mit Countdown, Verlaufs-Chart |
| `market.html` | P2P-Orderbuch: Token gegen EUR-Credits oder sBTC |
| `friends.html`, `chat.html` | Freundschaftssystem und 1:1-Chat (nur zwischen Freunden) |
| `stats.html` | „Key Numbers": Gesamt- und Tageskennzahlen mit Charts |
| `settings.html` | Walkthrough-Start, E-Mail-Fingerabdruck, Passwortwechsel, Konto löschen |
| `assets/app-core.js` | Gemeinsame Logik: API-Client, Dual-Modus, Navigation, Walkthrough, Formatierung |
| `assets/app.css` | Gemeinsame Styles (Design-Tokens, responsive, Dark) |
| `start-poolsite.bat` | Startet Server + Tunnel per Doppelklick |
| `mail-config.example.json` | Vorlage für den SMTP-Versand |

Design nach Anti-AI-Slop-Regeln (github.com/nutlope/hallmark): eine Akzentfarbe (Teal),
Font-Pairing Space Grotesk / IBM Plex Sans / IBM Plex Mono, keine Verläufe,
typografische Rhythmen statt Karten-Grids, keine Deko-Emojis in der Navigation.

## 3. Die Ökonomie (Kurzfassung der Regeln)

Basiert auf dem Whitepaper „Revenue-Anchored Closure" (Kernidee: wirtschaftliches
Gewicht muss durch unwiderruflichen Einsatz gedeckt sein — Sybil-Sicherheit per
Konstruktion statt per Bot-Detektor).

- **Preise:** Post 0,10 € · Kommentar 0,05 € · Like/Dislike 0,02 € (EUR-Credits).
  Jeder bezahlte Cent fließt unwiderruflich in den **Burn** (Commitment B).
- **Standing:** Rate r = B / max(N,1); α̂ = r / ν mit ν = 0,10 €. **Gate:** α̂ ≥ ρ = 0,2.
- **Tägliche Verteilung (00:00 UTC):** 5.000 PST + Carryover. Gewicht eines Creators =
  Σ über Engagement-Events auf seinen Inhalten: w_type (Like 1,0 / Kommentar 1,2 /
  Dislike 0,3) × abnehmende Erträge pro Actor-Paar (1/(1+0,3·(n−1))) × λ̂(α̂) des
  Reagierenden, nur bei offenem Gate. Selbst-Engagement zählt nicht, Gäste zählen
  weder als Geber noch als Empfänger. Kein Gewicht am Tag → Pool wird Carryover.
- **Cap:** 5.000/Tag, −10 %/Jahr → Gesamtmenge konvergiert exakt gegen 18,25 Mio. PST.
- **Einladungen:** Registrierung NUR mit Code (Ausnahme: allererstes Konto einer leeren
  DB). Ein Platz kostet 2 € (→ Burn des Einladenden). Eingeladene starten mit 10 €
  Startguthaben; **10 % ihrer verdienten Token gehen dauerhaft an den Einladenden**
  (abgezogen, nicht obendrauf — Cap bleibt intakt).
- **Markt:** Verkaufsangebote (Menge ≥ 1 PST) in EUR oder sBTC; Token liegen bis
  Verkauf/Rückzug im Treuhand-Depot. Teilkäufe möglich. **4 % Gebühr** vom Erlös,
  deren EUR-Gegenwert beim Verkäufer als Burn zählt. Letzter Preis (EUR-Äquivalent)
  bestimmt die angezeigte Marktkapitalisierung.
- **sBTC (Demo-Bitcoin, kein echtes Geld):** Faucet 0,0002/Tag, Burn an Dead-Address
  `sbtc1qdead…burn` zu festem Kurs 1 sBTC = 100.000 €. Kein echtes BTC — bewusst:
  echter BTC-Handel mit Anteils-Token wäre lizenzpflichtiger Finanzverkehr
  (Whitepaper: Phase-3-Legal-Gate).
- **Gäste:** dürfen lesen, aber nichts Token-Relevantes (kein Faucet/Burn/Markt,
  kein Verteilungsgewicht).
- **Content-Ranking im Feed:** Score = Engagement × Standing-Kernel des Reagierenden
  (gleiches Prinzip wie die Verteilung); „Heiß" = Score / (Alter_h + 2)^1,5.

## 4. Sicherheit & Datenschutz

- Passwörter: SHA-256(key:passwort) — Prototyp-Niveau (für Produktion: bcrypt/argon2).
- Sessions: zufällige Bearer-Tokens in der DB; Passwort-Reset beendet alte Sessions.
- **E-Mails werden NICHT gespeichert** — nur SHA-256(SECRET:email) als Fingerabdruck.
  Beim Reset gibt der Nutzer die Adresse erneut ein; nur bei Hash-Treffer wird der
  6-stellige Code (gehasht gespeichert, 15 Min gültig, max. 5 Versuche, 2-Min-Drossel)
  an genau diese Adresse gesendet. Antworten sind generisch (keine Konto-Enumeration).
- Uploads: Bilder werden **auf dem Gerät des Uploaders** auf ≤1280 px/JPEG komprimiert,
  Videos auf ≤7 s/480p re-encodiert (Canvas + MediaRecorder); Server validiert Format
  und Größe zusätzlich. Alle Nutzertexte werden escaped (kein HTML-Injection).
- `data/` ist komplett gitignored; ins öffentliche Repo gelangen nie Nutzerdaten,
  Schlüssel oder SMTP-Zugangsdaten.

## 5. Betrieb

**Starten:** Doppelklick auf `start-poolsite.bat` (öffnet zwei Fenster: Server +
Tunnel; die öffentliche URL steht im Tunnel-Fenster). Manuell:

```
node server.js
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000
```

**Nach jedem Neustart** ändert sich die Tunnel-URL → in `index.html` die
`trycloudflare`-Links aktualisieren (3 Stellen) und `git push` (GitHub Pages
deployt automatisch in ~1 Min).

**E-Mail-Versand:** `data/mail-config.json` — Gmail-Adresse + App-Passwort
(myaccount.google.com → Sicherheit → App-Passwörter). Ohne gültige Konfiguration
erscheinen Reset-Codes im Server-Konsolenfenster.

**Datenbank zurücksetzen:** Server stoppen, `data\db.json` löschen, starten.
Das allererste neue Konto darf sich dann ohne Einladung registrieren (Genesis).

## 6. Backups

`backup.js` sichert `db.json`, `media/`, `secret.key` und `mail-config.json`
nach `backups/backup-<zeitstempel>/`.

- **Automatisch:** beim Serverstart und danach alle 24 h; es werden die letzten
  **30** Backups aufbewahrt, ältere automatisch gelöscht.
- **Manuell:**
  ```
  node backup.js            # Backup jetzt anlegen
  node backup.js list       # vorhandene Backups zeigen
  node backup.js restore backup-2026-07-24T13-30-29 --force   # zurückspielen
  ```
- Restore legt vor dem Überschreiben automatisch ein Sicherheits-Backup des
  aktuellen Stands an. Danach Server neu starten.
- Backups enthalten **keine Klartext-E-Mails** (die gibt es nirgends), aber
  `secret.key` und die SMTP-Zugangsdaten → Backup-Ordner niemals veröffentlichen.
  Für Katastrophenschutz gelegentlich einen `backup-…`-Ordner auf einen USB-Stick
  oder eine zweite Platte kopieren.

## 7. API-Referenz (Kurz)

Auth per `Authorization: Bearer <token>` (von register/login/guest).

| Endpunkt | Zweck |
|---|---|
| `GET /api/health` | Live-Modus-Erkennung |
| `POST /api/register` | Konto anlegen — `{username, password, email?, inviteCode}` |
| `POST /api/login` / `POST /api/logout` | Sitzung |
| `POST /api/guest` / `POST /api/upgrade` | Gast anlegen / mit Einladung in Vollkonto wandeln |
| `GET/DELETE /api/me` | Eigenes Profil / Konto löschen |
| `POST /api/avatar`, `POST /api/settings` | Profilbild; E-Mail-Fingerabdruck & Passwort |
| `POST /api/reset/request` / `confirm` | Passwort-Reset per Mail-Code |
| `GET /api/posts?sort=&type=&range=&friends=` | Feed mit Ranking/Filtern |
| `POST /api/posts` | Beitrag `{text?, image?, video?}` (mind. eines) |
| `POST /api/posts/:id/react` `{kind}` | Like/Dislike (gegenseitig exklusiv) |
| `POST/DELETE /api/posts/:id/comments[/:cid]` | Kommentieren / eigenen löschen |
| `DELETE /api/posts/:id` | Eigenen Beitrag löschen |
| `GET /api/wallet` | Token, Historie, Live-Gewicht heute, Countdown, Preis/Marketcap |
| `POST /api/btc/faucet` / `POST /api/btc/burn` | sBTC holen / zu Credits verbrennen |
| `GET /api/market`, `POST /api/market/offers`, `DELETE /api/market/offers/:id`, `POST /api/market/offers/:id/buy` | P2P-Handel |
| `GET/POST /api/invites` | Eigene Einladungen / neue kaufen `{seats}` |
| `GET /api/users?q=` | Nutzersuche mit Beziehungsstatus |
| `GET /api/friends`, `POST /api/friends/request|accept|decline`, `DELETE /api/friends/:key` | Freundschaften |
| `GET/POST /api/chat/:key` | Nachrichtenverlauf / senden (nur Freunde) |
| `GET /api/stats` | Key Numbers (öffentlich, aggregiert) |

## 8. Bekannte Grenzen (ehrlich)

- Heim-PC = Single Point of Failure; PC aus → Plattform offline.
- JSON-Datei-DB: bei jedem Schreiben wird alles persistiert — gut bis einige
  hundert Nutzer, danach echte DB (SQLite/Postgres) nötig.
- Passwort-Hashing ohne Kosten-Faktor, kein Rate-Limit auf Login, kein CSRF-Schutz
  (Token-Header mildert das) — Prototyp, nicht auditiert.
- Browser-kodierte Videos sind meist WebM → ältere iPhones (< iOS 17.4) spielen sie
  ggf. nicht ab.
- Tunnel-URL wechselt bei Neustart; feste Domain erst mit eigenem Cloudflare-Konto
  oder gekaufter Domain.
- Alles Geld/Token in der App ist **Demo** — kein echtes Zahlungsmittel, keine
  echten Wertpapiere. Vor einem echten Launch: rechtliche Prüfung (BaFin, Prospekt).
