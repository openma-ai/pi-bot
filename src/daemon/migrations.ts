import type { DatabaseSync } from 'node:sqlite';
export function migrate(db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,method TEXT NOT NULL,bot_id TEXT,thread_id TEXT,turn_id TEXT,data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id,seq);CREATE INDEX IF NOT EXISTS events_bot ON events(bot_id,seq);
 CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS turns_thread ON turns(json_extract(data,'$.threadId'));
 CREATE INDEX IF NOT EXISTS requests_state ON requests(json_extract(data,'$.status'));
 CREATE TABLE IF NOT EXISTS event_retention(id INTEGER PRIMARY KEY CHECK(id=1),floor INTEGER NOT NULL);INSERT OR IGNORE INTO event_retention VALUES(1,0);`);
    if (!db.prepare('SELECT version FROM schema_version').get())
        db.prepare('INSERT INTO schema_version VALUES(1)').run();
}
