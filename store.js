/* PoolSite Storage — SQLite als Dokumentspeicher (eingebautes node:sqlite, keine Abhängigkeiten).
 *
 * Warum so: Die Geschäftslogik arbeitet weiter auf einem In-Memory-Objekt `db` (schnellste Lesezugriffe).
 * Beim Speichern werden über Änderungserkennung NUR die tatsächlich veränderten Zeilen in eine
 * transaktionssichere SQLite-Datei geschrieben — nicht mehr die ganze 2,4-MB-Datei bei jeder Aktion.
 *
 * Eine generische Tabelle kv(collection, id, data) hält alle Entitäten als JSON-Zeilen:
 *   - OBJECT-Collections (Map key→obj): users, sessions, invites, stats
 *   - ARRAY-Collections  (Array mit .id): posts, offers, trades, messages
 *   - BLOB-Collections   (ein Blob):      friendRequests, events, meta
 */
const { DatabaseSync } = require('node:sqlite');

const OBJECT_COLLS = ['users', 'sessions', 'invites', 'stats'];
const ARRAY_COLLS = ['posts', 'offers', 'trades', 'messages'];
const BLOB_COLLS = ['friendRequests', 'events', 'meta'];
const ALL = OBJECT_COLLS.concat(ARRAY_COLLS, BLOB_COLLS);

let sdb = null, upStmt = null, delStmt = null;
const cache = {}; // collection -> Map(id -> letztes gespeichertes JSON)

function init(dbPath) {
  sdb = new DatabaseSync(dbPath);
  sdb.exec('PRAGMA journal_mode = WAL');       // gleichzeitiges Lesen/Schreiben, schnelle Commits
  sdb.exec('PRAGMA synchronous = NORMAL');     // sicher im WAL-Modus, deutlich schneller als FULL
  sdb.exec('CREATE TABLE IF NOT EXISTS kv (collection TEXT, id TEXT, data TEXT, PRIMARY KEY(collection, id))');
  upStmt = sdb.prepare('INSERT INTO kv(collection, id, data) VALUES(?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data');
  delStmt = sdb.prepare('DELETE FROM kv WHERE collection = ? AND id = ?');
  ALL.forEach(function (c) { cache[c] = new Map(); });
}

function isEmpty() {
  return sdb.prepare('SELECT COUNT(*) AS n FROM kv').get().n === 0;
}

function emptyDb() {
  return {
    users: {}, sessions: {}, invites: {}, stats: {},
    posts: [], offers: [], trades: [], messages: [],
    friendRequests: [], events: [], meta: null
  };
}

function load() {
  const db = emptyDb();
  const rows = sdb.prepare('SELECT collection, id, data FROM kv ORDER BY rowid').all();
  for (const r of rows) {
    if (cache[r.collection]) cache[r.collection].set(r.id, r.data);
    const val = JSON.parse(r.data);
    if (OBJECT_COLLS.indexOf(r.collection) >= 0) db[r.collection][r.id] = val;
    else if (ARRAY_COLLS.indexOf(r.collection) >= 0) db[r.collection].push(val);
    else if (BLOB_COLLS.indexOf(r.collection) >= 0) db[r.collection] = val;
  }
  return db;
}

function mapOfObject(obj) {
  const m = new Map();
  for (const k of Object.keys(obj || {})) m.set(k, obj[k]);
  return m;
}
function mapOfArray(arr) {
  const m = new Map();
  for (const it of (arr || [])) m.set(String(it.id), it);
  return m;
}

function persistCollection(coll, curMap) {
  const cch = cache[coll];
  for (const [id, val] of curMap) {
    const json = JSON.stringify(val);
    if (cch.get(id) !== json) { upStmt.run(coll, id, json); cch.set(id, json); } // nur bei Änderung schreiben
  }
  for (const id of Array.from(cch.keys())) {
    if (!curMap.has(id)) { delStmt.run(coll, id); cch.delete(id); } // gelöschte Entitäten entfernen
  }
}

function persist(db) {
  sdb.exec('BEGIN IMMEDIATE');
  try {
    for (const c of OBJECT_COLLS) persistCollection(c, mapOfObject(db[c]));
    for (const c of ARRAY_COLLS) persistCollection(c, mapOfArray(db[c]));
    for (const c of BLOB_COLLS) persistCollection(c, new Map([['_', db[c] === undefined ? null : db[c]]]));
    sdb.exec('COMMIT');
  } catch (e) {
    try { sdb.exec('ROLLBACK'); } catch (x) {}
    throw e;
  }
}

function checkpoint() { try { sdb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {} }
function close() { try { checkpoint(); sdb.close(); } catch (e) {} }

module.exports = { init, isEmpty, load, persist, checkpoint, close, emptyDb };
