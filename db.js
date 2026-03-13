const path = require('path')
const fs = require('fs/promises')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')

const USE_POSTGRES = Boolean(process.env.POSTGRES_URL)
let sqliteDbPromise = null
let pgAdapterPromise = null

function getDatabaseFilePath() {
  if (process.env.VERCEL) {
    return '/tmp/order2books.sqlite'
  }
  return path.join(__dirname, 'data.sqlite')
}

async function getSqliteDb() {
  if (!sqliteDbPromise) {
    sqliteDbPromise = open({
      filename: getDatabaseFilePath(),
      driver: sqlite3.Database,
    })
  }

  const db = await sqliteDbPromise
  await db.exec('PRAGMA foreign_keys = ON;')
  return db
}

function transformQuery(sql, params = []) {
  if (!params.length) {
    return { text: sql, values: [] }
  }

  let index = 0
  const text = sql.replace(/\?/g, () => {
    index += 1
    return `$${index}`
  })
  return { text, values: params }
}

async function createPostgresAdapter() {
  const { Pool } = require('pg')
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false },
  })

  pool.on('error', (error) => {
    console.error('Postgres pool error', error)
  })

  const adapter = {
    async run(sql, params = []) {
      const { text, values } = transformQuery(sql, params)
      return pool.query(text, values)
    },
    async get(sql, params = []) {
      const result = await adapter.run(sql, params)
      return result.rows[0] || null
    },
    async all(sql, params = []) {
      const result = await adapter.run(sql, params)
      return result.rows
    },
    async exec(sql) {
      const statements = String(sql)
        .split(/;\s*/)
        .map((statement) => statement.trim())
        .filter(Boolean)
      for (const statement of statements) {
        await pool.query(statement)
      }
    },
  }

  return adapter
}

async function getDb() {
  if (USE_POSTGRES) {
    if (!pgAdapterPromise) {
      pgAdapterPromise = createPostgresAdapter()
    }
    return pgAdapterPromise
  }

  return getSqliteDb()
}

function sanitizeIdentifier(identifier) {
  if (!/^[a-zA-Z0-9_]+$/.test(identifier)) {
    throw new Error(`Invalid identifier: ${identifier}`)
  }
  return identifier
}

async function ensureColumnExists(db, tableName, columnName, columnDefinition) {
  sanitizeIdentifier(tableName)
  sanitizeIdentifier(columnName)

  if (USE_POSTGRES) {
    const exists = await db.get(
      'SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?',
      [tableName.toLowerCase(), columnName.toLowerCase()],
    )
    if (!exists) {
      await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`)
    }
    return
  }

  const columns = await db.all(`PRAGMA table_info(${tableName})`)
  const hasColumn = columns.some((column) => column.name === columnName)

  if (!hasColumn) {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`)
  }
}

async function ensureTableExists(db, createTableSql) {
  await db.exec(createTableSql)
}

async function migrateSqlite() {
  const db = await getDb()
  const migrationPath = path.join(__dirname, 'migrations', '001_init.sql')
  const sql = await fs.readFile(migrationPath, 'utf8')
  await db.exec(sql)
  await ensureColumnExists(db, 'app_settings', 'auto_create_qbo_items', 'INTEGER NOT NULL DEFAULT 1')
  await ensureColumnExists(db, 'app_settings', 'capture_mode', "TEXT NOT NULL DEFAULT 'auto'")
  await ensureTableExists(
    db,
    `CREATE TABLE IF NOT EXISTS product_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      mapping_key TEXT NOT NULL,
      shopify_product_id TEXT,
      shopify_variant_id TEXT,
      shopify_sku TEXT,
      shopify_title TEXT NOT NULL,
      qbo_item_id TEXT,
      qbo_item_name TEXT,
      mapping_source TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'needs_attention',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      UNIQUE (shop_id, mapping_key)
    )`,
  )
  await db.exec('CREATE INDEX IF NOT EXISTS idx_product_mappings_shop_id ON product_mappings(shop_id)')
  await db.exec('CREATE INDEX IF NOT EXISTS idx_product_mappings_status ON product_mappings(status)')
}

async function migratePostgres() {
  const db = await getDb()
  await db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL UNIQUE,
      shopify_access_token TEXT,
      shopify_scope TEXT,
      qbo_realm_id TEXT,
      qbo_access_token TEXT,
      qbo_refresh_token TEXT,
      qbo_token_expires_at TEXT,
      is_installed INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_syncs (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      shopify_order_id TEXT NOT NULL,
      shopify_order_name TEXT,
      qbo_customer_id TEXT,
      qbo_invoice_id TEXT,
      financial_status TEXT,
      sync_status TEXT NOT NULL,
      last_error TEXT,
      synced_at TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (shop_id, shopify_order_id)
    );

    CREATE TABLE IF NOT EXISTS sync_logs (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
      shopify_order_id TEXT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      payload_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id SERIAL PRIMARY KEY,
      shopify_domain TEXT,
      shopify_api_key TEXT,
      qbo_connected INTEGER DEFAULT 0,
      auto_decrement_inventory INTEGER DEFAULT 0,
      auto_create_qbo_items INTEGER NOT NULL DEFAULT 1,
      capture_mode TEXT NOT NULL DEFAULT 'auto',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS product_mappings (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      mapping_key TEXT NOT NULL,
      shopify_product_id TEXT,
      shopify_variant_id TEXT,
      shopify_sku TEXT,
      shopify_title TEXT NOT NULL,
      qbo_item_id TEXT,
      qbo_item_name TEXT,
      mapping_source TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'needs_attention',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (shop_id, mapping_key)
    );

    CREATE INDEX IF NOT EXISTS idx_order_syncs_shop_id ON order_syncs(shop_id);
    CREATE INDEX IF NOT EXISTS idx_sync_logs_shop_id ON sync_logs(shop_id);
    CREATE INDEX IF NOT EXISTS idx_sync_logs_order_id ON sync_logs(shopify_order_id);
    CREATE INDEX IF NOT EXISTS idx_product_mappings_shop_id ON product_mappings(shop_id);
    CREATE INDEX IF NOT EXISTS idx_product_mappings_status ON product_mappings(status);
  `)
}

async function migrate() {
  if (USE_POSTGRES) {
    await migratePostgres()
  } else {
    await migrateSqlite()
  }
}

module.exports = {
  getDb,
  migrate,
}
