/* PoolSite Backup — sichert Datenbank, Medien und Schlüssel ohne Abhängigkeiten.
 *
 * Nutzung (aus dem Projektordner):
 *   node backup.js              → neues Backup anlegen (und alte über die Aufbewahrung hinaus löschen)
 *   node backup.js list         → vorhandene Backups auflisten
 *   node backup.js restore <ordner> --force   → ein Backup zurückspielen (überschreibt data/)
 *
 * Der Server ruft runBackup() zusätzlich automatisch beim Start und danach täglich auf.
 *
 * Gesichert werden:
 *   data/db.json         — alle Konten, Beiträge, Markt, Einladungen, Statistiken
 *   data/media/          — hochgeladene Videos
 *   data/secret.key      — Salt für die E-Mail-Fingerabdrücke (OHNE ihn ist kein Passwort-Reset möglich!)
 *   data/mail-config.json— SMTP-Zugangsdaten (sensibel)
 *
 * Datenschutz: Es werden KEINE Klartext-E-Mail-Adressen gespeichert — die DB enthält nur
 * gesalzene Fingerabdrücke. Ein Backup enthält daher ebenfalls keine Adressen im Klartext.
 * Trotzdem enthält es secret.key und mail-config.json — Backups also sicher aufbewahren,
 * niemals öffentlich hochladen.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(ROOT, 'backups');
const KEEP = 30; // so viele Backups aufbewahren

// SQLite-Datei (inkl. WAL/SHM für Konsistenz), Schlüssel, Mail-Config und Medien.
// db.json nur noch als Alt-/Migrationskopie, falls vorhanden.
const ITEMS = ['poolsite.db', 'poolsite.db-wal', 'poolsite.db-shm', 'secret.key', 'mail-config.json', 'media', 'db.json.migrated'];

function stamp() {
  // ISO-Zeit ohne Doppelpunkte (Windows-dateinamensicher), inkl. Millisekunden: 2026-07-24T13-05-09-123
  return new Date().toISOString().replace('Z', '').replace(/[:.]/g, '-');
}

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dst, name));
  } else {
    fs.copyFileSync(src, dst);
  }
}

function dirSize(p) {
  let total = 0;
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const n of fs.readdirSync(p)) total += dirSize(path.join(p, n)); }
  else total += st.size;
  return total;
}

function runBackup(opts) {
  opts = opts || {};
  if (!fs.existsSync(DATA_DIR)) { if (!opts.quiet) console.log('[backup] Kein data/-Ordner — nichts zu sichern.'); return null; }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let name = 'backup-' + stamp();
  let dest = path.join(BACKUP_DIR, name);
  let n = 1;
  while (fs.existsSync(dest)) { name = 'backup-' + stamp() + '-' + (n++); dest = path.join(BACKUP_DIR, name); }
  fs.mkdirSync(dest);

  let count = 0;
  for (const item of ITEMS) {
    const src = path.join(DATA_DIR, item);
    if (fs.existsSync(src)) { copyRecursive(src, path.join(dest, item)); count++; }
  }
  const size = dirSize(dest);
  prune(opts);
  if (!opts.quiet) console.log('[backup] ' + name + ' angelegt (' + count + ' Elemente, ' + Math.round(size / 1024) + ' KB).');
  return dest;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(n => n.startsWith('backup-'))
    .sort()
    .map(n => ({ name: n, path: path.join(BACKUP_DIR, n), size: dirSize(path.join(BACKUP_DIR, n)) }));
}

function prune(opts) {
  const all = listBackups();
  const remove = all.slice(0, Math.max(0, all.length - KEEP));
  for (const b of remove) {
    fs.rmSync(b.path, { recursive: true, force: true });
    if (!opts || !opts.quiet) console.log('[backup] Alt-Backup entfernt: ' + b.name);
  }
}

function restore(folder, force) {
  const src = path.isAbsolute(folder) ? folder : path.join(BACKUP_DIR, folder);
  if (!fs.existsSync(src)) { console.error('[restore] Backup nicht gefunden: ' + src); process.exit(1); }
  if (!force) {
    console.error('[restore] Das überschreibt data/ mit dem Backup. Zur Sicherheit --force anhängen:');
    console.error('  node backup.js restore ' + folder + ' --force');
    process.exit(1);
  }
  // Vor dem Zurückspielen ein Sicherheits-Backup des aktuellen Stands anlegen
  runBackup({ quiet: true });
  for (const item of ITEMS) {
    const from = path.join(src, item);
    const to = path.join(DATA_DIR, item);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    copyRecursive(from, to);
  }
  console.log('[restore] Aus ' + path.basename(src) + ' zurückgespielt. Server neu starten.');
}

module.exports = { runBackup, listBackups, restore, BACKUP_DIR };

// ---- CLI ----
if (require.main === module) {
  const cmd = process.argv[2] || 'backup';
  if (cmd === 'list') {
    const all = listBackups();
    if (!all.length) { console.log('Keine Backups vorhanden.'); }
    else all.forEach(b => console.log(b.name + '  (' + Math.round(b.size / 1024) + ' KB)'));
  } else if (cmd === 'restore') {
    restore(process.argv[3], process.argv.includes('--force'));
  } else {
    runBackup();
  }
}
