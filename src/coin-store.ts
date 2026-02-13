import { Pool } from 'pg';

export interface DbUser {
  id: string;
  username: string;
  coins: number;
}

export interface CoinUpdate {
  userId: string;
  coins: number;
}

const DEFAULT_START_COINS = (() => {
  const n = Number(process.env.DEFAULT_START_COINS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 100000;
})();

const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL
});

let schemaReady = false;
let schemaPromise: Promise<void> | null = null;

function normalizeCoins(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_START_COINS;
  return Math.max(0, Math.floor(n));
}

async function ensureSchema(): Promise<void> {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required for permanent coin storage');
  }
  if (schemaReady) return;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT ${DEFAULT_START_COINS}
      `
    );
    schemaReady = true;
  })();

  await schemaPromise;
}

export async function getUserById(userId: string): Promise<DbUser | null> {
  await ensureSchema();
  const result = await pool.query(
    `SELECT id, username, coins FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: String(row.id),
    username: String(row.username),
    coins: normalizeCoins(row.coins)
  };
}

export async function persistCoinSettlement(updates: CoinUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  await ensureSchema();

  const unique = new Map<string, number>();
  for (const update of updates) {
    if (!update.userId) continue;
    unique.set(update.userId, normalizeCoins(update.coins));
  }

  if (unique.size === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [userId, coins] of unique.entries()) {
      await client.query(
        `UPDATE users SET coins = $2 WHERE id = $1`,
        [userId, coins]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
