import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Sql {
  query<T extends pg.QueryResultRow = Record<string, any>>(sql: string, values?: any[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDatabase(location?: string, connection?: string): Promise<Database> {
  if (connection) {
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    const lock = await client.query('SELECT pg_try_advisory_lock(1551412456, 50401300) AS locked');
    if (!lock.rows[0]?.locked) { await client.end(); throw new Error('Another bot worker holds the database lock.'); }
    const adapter: Database = {
      query: <T extends pg.QueryResultRow>(sql: string, values?: any[]) => client.query<T>(sql, values),
      async transaction(fn) {
        await client.query('BEGIN');
        try { const result = await fn(adapter); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; }
      },
      close: () => client.end(),
    };
    return adapter;
  }
  const local = new PGlite(location);
  await local.waitReady;
  return {
    query: (sql, values) => local.query(sql, values),
    transaction: fn => local.transaction(tx => fn(tx)),
    close: () => local.close(),
  };
}

export async function migrate(db: Database, guildId: string): Promise<void> {
  const schema = `
    CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS members (
      id text PRIMARY KEY, name text NOT NULL, bot boolean NOT NULL, created_at double precision NOT NULL,
      joined_at double precision NOT NULL, present boolean NOT NULL, pending boolean NOT NULL,
      baseline boolean NOT NULL, dm_opt_in boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS invites (
      code text PRIMARY KEY, owner_id text, uses integer NOT NULL,
      active boolean NOT NULL DEFAULT true, managed boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS referrals (
      invitee_id text PRIMARY KEY REFERENCES members(id), owner_id text,
      code text, first_joined double precision NOT NULL, since double precision NOT NULL,
      attribution text NOT NULL, status text NOT NULL, reason text NOT NULL DEFAULT '',
      review boolean NOT NULL DEFAULT false, excluded boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS audit (
      id bigserial PRIMARY KEY, at double precision NOT NULL, actor text NOT NULL,
      action text NOT NULL, subject text NOT NULL, detail jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reward_rules (
      id text PRIMARY KEY, threshold integer UNIQUE NOT NULL CHECK(threshold > 0),
      label text NOT NULL, enabled boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS awards (
      id text PRIMARY KEY, user_id text NOT NULL, rule_id text NOT NULL REFERENCES reward_rules(id),
      threshold integer NOT NULL, label text NOT NULL, earned_at double precision NOT NULL,
      status text NOT NULL DEFAULT 'awaiting_staff', assigned_to text, fulfilled_at double precision,
      staff_message_id text, staff_channel_id text, evidence jsonb NOT NULL,
      UNIQUE(user_id, rule_id)
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id text PRIMARY KEY, award_id text NOT NULL REFERENCES awards(id), kind text NOT NULL,
      state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      next_at double precision NOT NULL DEFAULT 0, message_id text, error text,
      UNIQUE(award_id, kind)
    );
    CREATE TABLE IF NOT EXISTS role_requests (
      id text PRIMARY KEY, user_id text NOT NULL, role_id text NOT NULL,
      status text NOT NULL CHECK(status IN ('pending','approved','denied','cancelled')),
      requested_at double precision NOT NULL, decided_at double precision,
      decided_by text, staff_message_id text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_role_request
      ON role_requests(user_id,role_id) WHERE status='pending';
  `;
  for (const statement of schema.split(';').filter(s => s.trim())) await db.query(statement);
  const current = (await db.query('SELECT value FROM settings WHERE key=$1', ['guild_id'])).rows[0];
  if (current && current.value !== guildId) throw new Error('This database belongs to a different Discord server.');
  await db.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING', ['guild_id', JSON.stringify(guildId)]);
}

export async function setting<T>(db: Sql, key: string, fallback: T): Promise<T> {
  const row = (await db.query('SELECT value FROM settings WHERE key=$1', [key])).rows[0];
  return row ? row.value as T : fallback;
}
export async function setSetting(db: Sql, key: string, value: unknown): Promise<void> {
  await db.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]);
}
export async function audit(db: Sql, at: number, actor: string, action: string, subject: string, detail: unknown): Promise<void> {
  await db.query('INSERT INTO audit(at,actor,action,subject,detail) VALUES($1,$2,$3,$4,$5)', [at, actor, action, subject, JSON.stringify(detail)]);
}
