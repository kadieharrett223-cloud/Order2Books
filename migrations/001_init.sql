CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_domain TEXT NOT NULL UNIQUE,
  shopify_access_token TEXT,
  shopify_scope TEXT,
  qbo_realm_id TEXT,
  qbo_access_token TEXT,
  qbo_refresh_token TEXT,
  qbo_token_expires_at TEXT,
  is_installed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  shopify_order_id TEXT NOT NULL,
  shopify_order_name TEXT,
  qbo_customer_id TEXT,
  qbo_invoice_id TEXT,
  financial_status TEXT,
  sync_status TEXT NOT NULL,
  last_error TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE (shop_id, shopify_order_id)
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER,
  shopify_order_id TEXT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_order_syncs_shop_id ON order_syncs(shop_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_shop_id ON sync_logs(shop_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_order_id ON sync_logs(shopify_order_id);

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY,
  shopify_domain TEXT,
  shopify_api_key TEXT,
  qbo_connected INTEGER DEFAULT 0,
  auto_decrement_inventory INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
