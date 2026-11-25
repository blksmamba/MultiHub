import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { defaultSettings, type Activity, type AppState, type Profile, type ProfileInput, type ProfileSettings, type Settings } from '../src/shared'

export interface Source { projectId: string; versionId: string }

export class Store {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, directory TEXT COLLATE NOCASE UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (profile TEXT NOT NULL, title TEXT NOT NULL, date INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS source (hash TEXT PRIMARY KEY, project TEXT NOT NULL, version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, date INTEGER NOT NULL);
    `)
  }

  private pref<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM preferences WHERE key = ?').get(key)
    return row ? JSON.parse(String(row.value)) as T : fallback
  }

  private set(key: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO preferences VALUES (?, ?)').run(key, JSON.stringify(value))
  }

  deferredAppUpdate() { return this.pref<string>('deferred-app-update', '') }
  deferAppUpdate(version: string) { this.set('deferred-app-update', version) }

  state(): AppState {
    const profiles = this.db.prepare('SELECT data FROM profiles ORDER BY rowid').all().map(row => JSON.parse(String(row.data)) as Profile)
    const activeId = this.pref<string | null>('active', null)
    return { profiles, activeId: profiles.some(profile => profile.id === activeId) ? activeId : profiles[0]?.id ?? null, settings: this.readSettings() }
  }

  profile(id: string): Profile {
    const row = this.db.prepare('SELECT data FROM profiles WHERE id = ?').get(id)
    if (!row) throw new Error('Профиль не найден.')
    return JSON.parse(String(row.data)) as Profile
  }

  save(input: ProfileInput) {
    const existing = this.db.prepare('SELECT id FROM profiles WHERE directory = ?').get(input.directory)
    if (existing) throw new Error('Эта игровая папка уже подключена.')
    const profile = { ...input, id: randomUUID(), updated: Date.now() }
    this.db.prepare('INSERT INTO profiles VALUES (?, ?, ?)').run(profile.id, profile.directory, JSON.stringify(profile))
    return this.select(profile.id)
  }

  select(id: string) {
    this.profile(id)
    this.set('active', id)
    return this.state()
  }

  updateProfileSettings(profile: Profile, settings: ProfileSettings) {
    const updated = { ...profile, name: settings.name }
    if (profile.launcher) {
      updated.launcher = {
        ...profile.launcher,
        ...(settings.heapMiB === undefined ? {} : { heapMiB: settings.heapMiB }),
        nickname: settings.nickname ?? profile.launcher.nickname,
      }
    }
    this.db.prepare('UPDATE profiles SET data = ? WHERE id = ?').run(JSON.stringify(updated), updated.id)
    return updated
  }

  markGameInstalled(id: string) {
    const profile = this.profile(id)
    if (!profile.launcher || profile.launcher.installed !== false) return
    const updated = { ...profile, launcher: { ...profile.launcher, installed: true } }
    this.db.prepare('UPDATE profiles SET data = ? WHERE id = ?').run(JSON.stringify(updated), id)
  }

  removeProfile(id: string) {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM activity WHERE profile = ?').run(id)
      this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id)
      if (this.pref('active', '') === id) this.set('active', this.state().activeId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.state()
  }

  readSettings(): Settings {
    return { ...defaultSettings, ...this.pref<Partial<Settings>>('settings', {}) }
  }

  updateSettings(changes: Partial<Settings>) {
    this.set('settings', { ...this.readSettings(), ...changes })
    return this.state()
  }

  record(id: string, title: string, sources: [string, Source][] = []) {
    const date = Date.now()
    const profile = this.profile(id)
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT INTO activity VALUES (?, ?, ?)').run(id, title, date)
      this.db.prepare('UPDATE profiles SET data = ? WHERE id = ?').run(JSON.stringify({ ...profile, updated: date }), id)
      for (const [hash, source] of sources) this.addSource(hash, source)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  history(id: string): Activity[] {
    return this.db.prepare('SELECT title, date FROM activity WHERE profile = ? ORDER BY date DESC LIMIT 15').all(id) as unknown as Activity[]
  }

  source(hash: string): Source | undefined {
    const row = this.db.prepare('SELECT project AS projectId, version AS versionId FROM source WHERE hash = ?').get(hash)
    return row as unknown as Source | undefined
  }

  addSource(hash: string, item: Source) {
    this.db.prepare('INSERT OR REPLACE INTO source VALUES (?, ?, ?)').run(hash, item.projectId, item.versionId)
  }

  cached<T>(key: string): { value: T; date: number } | undefined {
    const row = this.db.prepare('SELECT value, date FROM cache WHERE key = ?').get(key)
    return row ? { value: JSON.parse(String(row.value)) as T, date: Number(row.date) } : undefined
  }

  cache(key: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO cache VALUES (?, ?, ?)').run(key, JSON.stringify(value), Date.now())
    this.db.exec('DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY date DESC LIMIT -1 OFFSET 400)')
  }

  clearCache() { this.db.exec('DELETE FROM cache') }
}
