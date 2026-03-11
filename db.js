const path = require('path')
const fs = require('fs/promises')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')

let dbPromise

function getDatabaseFilePath() {
  if (process.env.VERCEL) {
    return '/tmp/order2books.sqlite'
  }
  return path.join(__dirname, 'data.sqlite')
}

async function getDb() {
  if (!dbPromise) {
    dbPromise = open({
      filename: getDatabaseFilePath(),
      driver: sqlite3.Database,
    })
  }

  const db = await dbPromise
  await db.exec('PRAGMA foreign_keys = ON;')
  return db
}

async function ensureColumnExists(db, tableName, columnName, columnDefinition) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`)
  const exists = columns.some((column) => column.name === columnName)

  if (!exists) {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`)
  }
}

async function ensureTableExists(db, createTableSql) {
  await db.exec(createTableSql)
}

async function migrate() {
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

module.exports = {
  getDb,
  migrate,
}
