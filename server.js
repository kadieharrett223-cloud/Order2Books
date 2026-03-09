const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const { migrate, getDb } = require('./db')
require('dotenv').config()

const app = express()
const port = Number(process.env.PORT || 4000)

// APP_URL - use from env, fallback to localhost for dev, or infer from Vercel
let APP_URL = process.env.APP_URL
if (!APP_URL) {
  if (process.env.VERCEL_URL) {
    APP_URL = `https://${process.env.VERCEL_URL}`
  } else {
    APP_URL = `http://localhost:${port}`
  }
}

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || ''
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || ''
const SHOPIFY_SCOPES = process.env.SHOPIFY_SCOPES || 'read_orders'
const STATE_SECRET = process.env.STATE_SECRET || 'dev-state-secret'

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || ''
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || ''
const QBO_SCOPES = process.env.QBO_SCOPES || 'com.intuit.quickbooks.accounting'
const QBO_ENV = process.env.QBO_ENV === 'production' ? 'production' : 'sandbox'
const QBO_MINOR_VERSION = process.env.QBO_MINOR_VERSION || '75'
const QBO_ITEM_REF = process.env.QBO_ITEM_REF || '1'
let activePlanKey = String(process.env.APP_PLAN || 'starter').toLowerCase() === 'scale' ? 'scale' : 'starter'

const PLAN_CONFIG = {
  starter: {
    key: 'starter',
    name: 'Starter',
    priceMonthly: 9.99,
    orderLimitPerMonth: 200,
    features: [
      'Up to 200 orders / month',
      'Basic order → invoice sync',
      'Manual retry',
      'Email support',
    ],
    supportsMultiStore: false,
  },
  scale: {
    key: 'scale',
    name: 'Scale',
    priceMonthly: 29,
    orderLimitPerMonth: null,
    features: [
      'Unlimited orders',
      'Multi-store support',
      'Advanced reporting',
      'Dedicated support',
    ],
    supportsMultiStore: true,
  },
}

const ALLOW_DEV_WEBHOOK_WITHOUT_HMAC = process.env.ALLOW_DEV_WEBHOOK_WITHOUT_HMAC === 'true'

app.use(cors())
app.use(
  express.json({
    verify: (req, res, buffer) => {
      req.rawBody = buffer
    },
  }),
)

function nowIso() {
  return new Date().toISOString()
}

function getActivePlanConfig() {
  return PLAN_CONFIG[activePlanKey]
}

function monthRangeUtc() {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return { start: start.toISOString(), end: end.toISOString() }
}

function buildShopifyCallbackUrl() {
  return `${APP_URL}/api/auth/shopify/callback`
}

function buildQboCallbackUrl() {
  return `${APP_URL}/api/auth/qbo/callback`
}

function qboApiBaseUrl() {
  if (QBO_ENV === 'production') {
    return 'https://quickbooks.api.intuit.com'
  }
  return 'https://sandbox-quickbooks.api.intuit.com'
}

function createSignedState(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', STATE_SECRET).update(data).digest('base64url')
  return `${data}.${signature}`
}

function verifySignedState(state) {
  const [data, signature] = String(state || '').split('.')
  if (!data || !signature) {
    throw new Error('Invalid OAuth state format')
  }

  const expected = crypto.createHmac('sha256', STATE_SECRET).update(data).digest('base64url')
  if (expected !== signature) {
    throw new Error('Invalid OAuth state signature')
  }

  const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
  if (!payload.ts || Date.now() - Number(payload.ts) > 10 * 60 * 1000) {
    throw new Error('OAuth state expired')
  }

  return payload
}

function validateShopDomain(shopDomain) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(String(shopDomain || ''))
}

function verifyShopifyCallbackHmac(queryParams) {
  if (!SHOPIFY_API_SECRET) {
    throw new Error('SHOPIFY_API_SECRET is required')
  }

  const keys = Object.keys(queryParams)
    .filter((key) => key !== 'hmac' && key !== 'signature')
    .sort()

  const message = keys
    .map((key) => `${key}=${Array.isArray(queryParams[key]) ? queryParams[key].join(',') : queryParams[key]}`)
    .join('&')

  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(queryParams.hmac || '')))
}

function verifyShopifyWebhookHmac(req) {
  const header = req.get('x-shopify-hmac-sha256')
  if (!header || !SHOPIFY_API_SECRET) {
    return false
  }

  const digest = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(req.rawBody || Buffer.from(''))
    .digest('base64')

  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(digest))
  } catch {
    return false
  }
}

async function writeSyncLog({ shopId = null, shopifyOrderId = null, eventType, status, message, payload }) {
  const db = await getDb()
  await db.run(
    `INSERT INTO sync_logs (shop_id, shopify_order_id, event_type, status, message, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [shopId, shopifyOrderId, eventType, status, message, payload ? JSON.stringify(payload) : null, nowIso()],
  )
}

async function upsertShopFromShopifyOAuth({ shopDomain, accessToken, scope }) {
  const db = await getDb()
  await db.run(
    `INSERT INTO shops (shop_domain, shopify_access_token, shopify_scope, is_installed, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(shop_domain) DO UPDATE SET
       shopify_access_token = excluded.shopify_access_token,
       shopify_scope = excluded.shopify_scope,
       is_installed = 1,
       updated_at = excluded.updated_at`,
    [shopDomain, accessToken, scope, nowIso(), nowIso()],
  )

  return db.get(`SELECT * FROM shops WHERE shop_domain = ?`, [shopDomain])
}

async function getShopByDomain(shopDomain) {
  const db = await getDb()
  return db.get(`SELECT * FROM shops WHERE shop_domain = ?`, [shopDomain])
}

async function getShopById(shopId) {
  const db = await getDb()
  return db.get(`SELECT * FROM shops WHERE id = ?`, [shopId])
}

async function countInstalledShops() {
  const db = await getDb()
  const row = await db.get(`SELECT COUNT(*) AS count FROM shops WHERE is_installed = 1`)
  return Number(row?.count || 0)
}

async function countMonthlyOrderSyncs() {
  const db = await getDb()
  const { start, end } = monthRangeUtc()
  const row = await db.get(
    `SELECT COUNT(*) AS count
     FROM order_syncs
     WHERE created_at >= ? AND created_at < ?`,
    [start, end],
  )
  return Number(row?.count || 0)
}

async function updateQboTokensForShop({ shopId, realmId, accessToken, refreshToken, expiresAt }) {
  const db = await getDb()
  await db.run(
    `UPDATE shops
     SET qbo_realm_id = ?,
         qbo_access_token = ?,
         qbo_refresh_token = ?,
         qbo_token_expires_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [realmId, accessToken, refreshToken, expiresAt, nowIso(), shopId],
  )
}

async function markShopUninstalled(shopDomain) {
  const db = await getDb()
  await db.run(
    `UPDATE shops
     SET is_installed = 0,
         updated_at = ?
     WHERE shop_domain = ?`,
    [nowIso(), shopDomain],
  )
}

async function listOrderSyncs() {
  const db = await getDb()
  return db.all(
    `SELECT os.*, s.shop_domain
     FROM order_syncs os
     JOIN shops s ON s.id = os.shop_id
     ORDER BY COALESCE(os.synced_at, os.updated_at, os.created_at) DESC`,
  )
}

async function getOrderSyncByShopifyOrderId(shopifyOrderId) {
  const db = await getDb()
  return db.get(
    `SELECT os.*, s.shop_domain
     FROM order_syncs os
     JOIN shops s ON s.id = os.shop_id
     WHERE os.shopify_order_id = ?`,
    [String(shopifyOrderId)],
  )
}

async function getOrderSyncByUniqueKey(shopId, shopifyOrderId) {
  const db = await getDb()
  return db.get(
    `SELECT * FROM order_syncs WHERE shop_id = ? AND shopify_order_id = ?`,
    [shopId, String(shopifyOrderId)],
  )
}

async function createOrderSyncRecord({
  shopId,
  shopifyOrderId,
  shopifyOrderName,
  qboCustomerId,
  qboInvoiceId,
  qboPaymentId,
  financialStatus,
  syncStatus,
  lastError,
}) {
  const db = await getDb()
  await db.run(
    `INSERT INTO order_syncs (
      shop_id, shopify_order_id, shopify_order_name,
      qbo_customer_id, qbo_invoice_id, qbo_payment_id,
      financial_status, sync_status, last_error,
      synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      shopId,
      String(shopifyOrderId),
      shopifyOrderName,
      qboCustomerId,
      qboInvoiceId,
      qboPaymentId,
      financialStatus,
      syncStatus,
      lastError || null,
      nowIso(),
      nowIso(),
      nowIso(),
    ],
  )
}

async function updateOrderSyncStatus({
  shopId,
  shopifyOrderId,
  qboCustomerId,
  qboInvoiceId,
  qboPaymentId,
  financialStatus,
  syncStatus,
  lastError,
}) {
  const db = await getDb()
  await db.run(
    `UPDATE order_syncs
     SET qbo_customer_id = ?,
         qbo_invoice_id = ?,
         qbo_payment_id = ?,
         financial_status = ?,
         sync_status = ?,
         last_error = ?,
         synced_at = ?,
         updated_at = ?
     WHERE shop_id = ? AND shopify_order_id = ?`,
    [
      qboCustomerId,
      qboInvoiceId,
      qboPaymentId,
      financialStatus,
      syncStatus,
      lastError || null,
      nowIso(),
      nowIso(),
      shopId,
      String(shopifyOrderId),
    ],
  )
}

async function exchangeShopifyCodeForToken({ shop, code }) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Shopify token exchange failed: ${message}`)
  }

  return response.json()
}

async function exchangeQboCodeForToken({ code }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: buildQboCallbackUrl(),
  })

  const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`QBO token exchange failed: ${message}`)
  }

  return response.json()
}

async function refreshQboAccessToken(shop) {
  if (!shop.qbo_refresh_token) {
    throw new Error('Missing QuickBooks refresh token')
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: shop.qbo_refresh_token,
  })

  const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`QBO token refresh failed: ${message}`)
  }

  const token = await response.json()
  const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString()

  await updateQboTokensForShop({
    shopId: shop.id,
    realmId: shop.qbo_realm_id,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt,
  })

  return {
    ...shop,
    qbo_access_token: token.access_token,
    qbo_refresh_token: token.refresh_token,
    qbo_token_expires_at: expiresAt,
  }
}

async function ensureQboAccessToken(shop) {
  if (!shop.qbo_access_token || !shop.qbo_token_expires_at) {
    throw new Error('QuickBooks is not connected for this shop')
  }

  const expiresAtMs = new Date(shop.qbo_token_expires_at).getTime()
  const nowMs = Date.now()

  if (Number.isNaN(expiresAtMs) || expiresAtMs - nowMs < 60 * 1000) {
    return refreshQboAccessToken(shop)
  }

  return shop
}

async function qboRequest({ shop, method, path, body }) {
  const refreshedShop = await ensureQboAccessToken(shop)
  const response = await fetch(`${qboApiBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${refreshedShop.qbo_access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`QuickBooks API error (${response.status}): ${text}`)
  }

  return response.json()
}

async function qboFindCustomerByEmail(shop, email) {
  if (!email) return null
  const query = `select * from Customer where PrimaryEmailAddr = '${email.replace(/'/g, "\\'")}' maxresults 1`
  const response = await qboRequest({
    shop,
    method: 'GET',
    path: `/v3/company/${shop.qbo_realm_id}/query?query=${encodeURIComponent(query)}&minorversion=${QBO_MINOR_VERSION}`,
  })

  return response.QueryResponse?.Customer?.[0] || null
}

async function qboFindCustomerByDisplayName(shop, name) {
  if (!name) return null
  const query = `select * from Customer where DisplayName = '${name.replace(/'/g, "\\'")}' maxresults 1`
  const response = await qboRequest({
    shop,
    method: 'GET',
    path: `/v3/company/${shop.qbo_realm_id}/query?query=${encodeURIComponent(query)}&minorversion=${QBO_MINOR_VERSION}`,
  })

  return response.QueryResponse?.Customer?.[0] || null
}

async function qboCreateCustomer(shop, order) {
  const payload = {
    DisplayName: order.customerName || order.customerEmail || `Shopify Customer ${order.orderId}`,
    PrimaryEmailAddr: order.customerEmail ? { Address: order.customerEmail } : undefined,
    Notes: `source=Shopify; order=${order.orderName || order.orderId}`,
  }

  const response = await qboRequest({
    shop,
    method: 'POST',
    path: `/v3/company/${shop.qbo_realm_id}/customer?minorversion=${QBO_MINOR_VERSION}`,
    body: payload,
  })

  return response.Customer
}

async function qboFindOrCreateCustomer(shop, order) {
  let customer = await qboFindCustomerByEmail(shop, order.customerEmail)
  if (!customer) {
    customer = await qboFindCustomerByDisplayName(shop, order.customerName)
  }
  if (!customer) {
    customer = await qboCreateCustomer(shop, order)
  }

  return customer
}

function mapShopifyOrderToQboInvoiceLines(order) {
  const lines = []

  for (const line of order.lineItems || []) {
    const quantity = Number(line.quantity || 1)
    const unitPrice = Number(line.price || 0)
    const amount = Number((quantity * unitPrice).toFixed(2))

    lines.push({
      Amount: amount,
      Description: line.title || 'Shopify Item',
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        Qty: quantity,
        UnitPrice: unitPrice,
        ItemRef: { value: QBO_ITEM_REF },
      },
    })
  }

  if (Number(order.shipping || 0) > 0) {
    lines.push({
      Amount: Number(order.shipping),
      Description: 'Shipping',
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        Qty: 1,
        UnitPrice: Number(order.shipping),
        ItemRef: { value: QBO_ITEM_REF },
      },
    })
  }

  if (Number(order.tax || 0) > 0) {
    lines.push({
      Amount: Number(order.tax),
      Description: 'Tax',
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        Qty: 1,
        UnitPrice: Number(order.tax),
        ItemRef: { value: QBO_ITEM_REF },
      },
    })
  }

  if (lines.length === 0) {
    lines.push({
      Amount: Number(order.totalPrice || 0),
      Description: `Shopify Order ${order.orderName || order.orderId}`,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        Qty: 1,
        UnitPrice: Number(order.totalPrice || 0),
        ItemRef: { value: QBO_ITEM_REF },
      },
    })
  }

  return lines
}

async function qboCreateInvoice(shop, { order, customerId }) {
  const payload = {
    CustomerRef: { value: customerId },
    TxnDate: new Date(order.paidAt || nowIso()).toISOString().slice(0, 10),
    PrivateNote: `source=Shopify; order=${order.orderName || order.orderId}`,
    CustomerMemo: { value: `Shopify Order ${order.orderName || order.orderId}` },
    Line: mapShopifyOrderToQboInvoiceLines(order),
  }

  const response = await qboRequest({
    shop,
    method: 'POST',
    path: `/v3/company/${shop.qbo_realm_id}/invoice?minorversion=${QBO_MINOR_VERSION}`,
    body: payload,
  })

  return response.Invoice
}

async function qboCreatePayment(shop, { order, customerId, invoiceId }) {
  const payload = {
    CustomerRef: { value: customerId },
    TotalAmt: Number(order.totalPrice || 0),
    TxnDate: new Date(order.paidAt || nowIso()).toISOString().slice(0, 10),
    PrivateNote: `source=Shopify; order=${order.orderName || order.orderId}`,
    Line: [
      {
        Amount: Number(order.totalPrice || 0),
        LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }],
      },
    ],
  }

  const response = await qboRequest({
    shop,
    method: 'POST',
    path: `/v3/company/${shop.qbo_realm_id}/payment?minorversion=${QBO_MINOR_VERSION}`,
    body: payload,
  })

  return response.Payment
}

async function fetchShopifyOrderDetails(shop, webhookPayload) {
  if (webhookPayload.orderId && webhookPayload.lineItems) {
    return {
      orderId: String(webhookPayload.orderId),
      orderName: webhookPayload.orderName || `#${webhookPayload.orderId}`,
      financialStatus: String(webhookPayload.financialStatus || 'paid').toLowerCase(),
      paidAt: webhookPayload.paidAt || nowIso(),
      customerEmail: webhookPayload.customerEmail || null,
      customerName: webhookPayload.customerName || null,
      totalPrice: Number(webhookPayload.totalPrice || 0),
      shipping: Number(webhookPayload.shipping || 0),
      tax: Number(webhookPayload.tax || 0),
      lineItems: webhookPayload.lineItems || [],
    }
  }

  const orderId = String(webhookPayload.id || webhookPayload.order_id || '')
  if (!orderId) {
    throw new Error('Webhook payload missing order id')
  }

  const response = await fetch(
    `https://${shop.shop_domain}/admin/api/2024-10/orders/${orderId}.json`,
    {
      headers: {
        'X-Shopify-Access-Token': shop.shopify_access_token,
        'Content-Type': 'application/json',
      },
    },
  )

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Failed fetching Shopify order details: ${message}`)
  }

  const data = await response.json()
  const order = data.order

  return {
    orderId: String(order.id),
    orderName: order.name,
    financialStatus: String(order.financial_status || '').toLowerCase(),
    paidAt: order.processed_at || order.updated_at || nowIso(),
    customerEmail: order.email || order.customer?.email || null,
    customerName: [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || null,
    totalPrice: Number(order.current_total_price || order.total_price || 0),
    shipping: Number(order.total_shipping_price_set?.shop_money?.amount || 0),
    tax: Number(order.current_total_tax || order.total_tax || 0),
    lineItems: (order.line_items || []).map((item) => ({
      title: item.title,
      quantity: Number(item.quantity || 1),
      price: Number(item.price || 0),
    })),
  }
}

app.get('/api/health', (req, res) => {
  const plan = getActivePlanConfig()
  res.json({ ok: true, service: 'order2books-api', time: nowIso(), plan: plan.key })
})

app.get('/api/plan', async (req, res) => {
  const plan = getActivePlanConfig()
  const usedOrdersThisMonth = await countMonthlyOrderSyncs()
  const orderLimit = plan.orderLimitPerMonth

  res.json({
    plan: {
      key: plan.key,
      name: plan.name,
      priceMonthly: plan.priceMonthly,
      orderLimitPerMonth: orderLimit,
      usedOrdersThisMonth,
      remainingOrdersThisMonth: orderLimit == null ? null : Math.max(orderLimit - usedOrdersThisMonth, 0),
      supportsMultiStore: plan.supportsMultiStore,
      features: plan.features,
    },
    plans: Object.values(PLAN_CONFIG),
  })
})

app.post('/api/plan/upgrade', async (req, res) => {
  const desiredPlanKey = String(req.body?.planKey || '').toLowerCase().trim()
  const desiredPlan = PLAN_CONFIG[desiredPlanKey]

  if (!desiredPlan) {
    return res.status(400).json({ error: 'Invalid plan. Expected starter or scale.' })
  }

  if (desiredPlanKey === activePlanKey) {
    return res.json({
      success: true,
      message: `Already on ${desiredPlan.name}.`,
      plan: desiredPlan,
    })
  }

  activePlanKey = desiredPlanKey

  await writeSyncLog({
    eventType: 'plan/change',
    status: 'success',
    message: `Plan switched to ${desiredPlan.name}`,
    payload: { planKey: desiredPlan.key },
  })

  return res.json({
    success: true,
    message: `Upgraded to ${desiredPlan.name}`,
    plan: desiredPlan,
  })
})

app.get('/api/auth/shopify/install', async (req, res) => {
  try {
    const shop = String(req.query.shop || '').trim().toLowerCase()
    const plan = getActivePlanConfig()

    if (!validateShopDomain(shop)) {
      return res.status(400).json({ error: 'Invalid shop domain. Expected *.myshopify.com' })
    }

    if (!plan.supportsMultiStore) {
      const existingShop = await getShopByDomain(shop)
      const installedCount = await countInstalledShops()
      if (!existingShop && installedCount >= 1) {
        return res.status(403).json({
          error: 'Starter plan supports one store. Upgrade to Scale for multi-store support.',
        })
      }
    }

    if (!SHOPIFY_API_KEY) {
      return res.status(500).json({ error: 'SHOPIFY_API_KEY is not configured' })
    }

    const state = createSignedState({
      type: 'shopify',
      shop,
      ts: Date.now(),
    })

    const redirectUri = buildShopifyCallbackUrl()
    const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(
      SHOPIFY_API_KEY,
    )}&scope=${encodeURIComponent(SHOPIFY_SCOPES)}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&state=${encodeURIComponent(state)}`

    return res.redirect(installUrl)
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
})

app.get('/api/auth/shopify/callback', async (req, res) => {
  try {
    const { code, shop, state } = req.query

    const statePayload = verifySignedState(state)
    if (statePayload.type !== 'shopify' || statePayload.shop !== shop) {
      return res.status(400).json({ error: 'OAuth state mismatch' })
    }

    if (!verifyShopifyCallbackHmac(req.query)) {
      return res.status(401).json({ error: 'Invalid Shopify callback HMAC' })
    }

    const tokenResponse = await exchangeShopifyCodeForToken({ shop, code })

    const savedShop = await upsertShopFromShopifyOAuth({
      shopDomain: shop,
      accessToken: tokenResponse.access_token,
      scope: tokenResponse.scope,
    })

    await writeSyncLog({
      shopId: savedShop.id,
      eventType: 'shopify/oauth',
      status: 'success',
      message: 'Shopify OAuth connected and shop saved',
      payload: { shop, scope: tokenResponse.scope },
    })

    return res.redirect(`${APP_URL}/?shopify_connected=1&shop=${encodeURIComponent(shop)}`)
  } catch (error) {
    await writeSyncLog({
      eventType: 'shopify/oauth',
      status: 'failed',
      message: error.message,
      payload: req.query,
    })
    return res.status(500).json({ error: error.message })
  }
})

app.get('/api/auth/qbo/start', async (req, res) => {
  try {
    const shopDomain = String(req.query.shop || '').toLowerCase().trim()
    const shop = await getShopByDomain(shopDomain)

    if (!shop) {
      return res.status(404).json({ error: 'Shop not found. Complete Shopify OAuth first.' })
    }

    if (!QBO_CLIENT_ID) {
      return res.status(500).json({ error: 'QBO_CLIENT_ID is not configured' })
    }

    const state = createSignedState({
      type: 'qbo',
      shopId: shop.id,
      shop: shop.shop_domain,
      ts: Date.now(),
    })

    const authorizeUrl =
      `https://appcenter.intuit.com/connect/oauth2?` +
      `client_id=${encodeURIComponent(QBO_CLIENT_ID)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(QBO_SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(buildQboCallbackUrl())}` +
      `&state=${encodeURIComponent(state)}`

    return res.redirect(authorizeUrl)
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
})

app.get('/api/auth/qbo/callback', async (req, res) => {
  try {
    const { state, code, realmId } = req.query
    const statePayload = verifySignedState(state)

    if (statePayload.type !== 'qbo') {
      return res.status(400).json({ error: 'Invalid QuickBooks state payload' })
    }

    const db = await getDb()
    const shop = await db.get(`SELECT * FROM shops WHERE id = ?`, [statePayload.shopId])

    if (!shop) {
      return res.status(404).json({ error: 'Shop not found for QuickBooks callback' })
    }

    const token = await exchangeQboCodeForToken({ code })
    const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString()

    await updateQboTokensForShop({
      shopId: shop.id,
      realmId: String(realmId || ''),
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt,
    })

    await writeSyncLog({
      shopId: shop.id,
      eventType: 'qbo/oauth',
      status: 'success',
      message: 'QuickBooks connected and tokens saved',
      payload: { realmId },
    })

    return res.redirect(`${APP_URL}/?qbo_connected=1&shop=${encodeURIComponent(shop.shop_domain)}`)
  } catch (error) {
    await writeSyncLog({
      eventType: 'qbo/oauth',
      status: 'failed',
      message: error.message,
      payload: req.query,
    })
    return res.status(500).json({ error: error.message })
  }
})

app.get('/api/syncs', async (req, res) => {
  const syncs = await listOrderSyncs()
  return res.json({
    syncs: syncs.map((row) => ({
      shopId: row.shop_id,
      shopDomain: row.shop_domain,
      shopifyOrderId: row.shopify_order_id,
      shopifyOrderName: row.shopify_order_name,
      qboCustomerId: row.qbo_customer_id,
      qboInvoiceId: row.qbo_invoice_id,
      qboPaymentId: row.qbo_payment_id,
      financialStatus: row.financial_status,
      syncStatus: row.sync_status,
      lastError: row.last_error,
      syncedAt: row.synced_at,
    })),
  })
})

app.get('/api/syncs/:shopifyOrderId', async (req, res) => {
  const sync = await getOrderSyncByShopifyOrderId(req.params.shopifyOrderId)
  if (!sync) {
    return res.status(404).json({ error: 'Sync not found' })
  }

  return res.json({
    sync: {
      shopId: sync.shop_id,
      shopDomain: sync.shop_domain,
      shopifyOrderId: sync.shopify_order_id,
      shopifyOrderName: sync.shopify_order_name,
      qboCustomerId: sync.qbo_customer_id,
      qboInvoiceId: sync.qbo_invoice_id,
      qboPaymentId: sync.qbo_payment_id,
      financialStatus: sync.financial_status,
      syncStatus: sync.sync_status,
      lastError: sync.last_error,
      syncedAt: sync.synced_at,
    },
  })
})

app.post('/api/syncs/:shopifyOrderId/retry', async (req, res) => {
  const sync = await getOrderSyncByShopifyOrderId(req.params.shopifyOrderId)
  if (!sync) {
    return res.status(404).json({ error: 'Order sync not found' })
  }

  const shop = await getShopById(sync.shop_id)
  if (!shop) {
    return res.status(404).json({ error: 'Shop not found' })
  }

  // Check if QB is now connected
  const qboConnected = Boolean(shop.qbo_access_token && shop.qbo_realm_id)
  
  if (!qboConnected) {
    return res.status(400).json({ error: 'QuickBooks is not connected. Please connect QB in Settings first.' })
  }

  try {
    // Fetch the order details again from Shopify
    const order = await fetchShopifyOrderDetails(shop, {
      id: sync.shopify_order_id,
      orderName: sync.shopify_order_name,
    })

    // Try to sync to QB
    const customer = await qboFindOrCreateCustomer(shop, order)
    const invoice = await qboCreateInvoice(shop, {
      order,
      customerId: customer.Id,
    })
    const payment = await qboCreatePayment(shop, {
      order,
      customerId: customer.Id,
      invoiceId: invoice.Id,
    })

    await updateOrderSyncStatus({
      shopId: shop.id,
      shopifyOrderId: sync.shopify_order_id,
      qboCustomerId: customer.Id,
      qboInvoiceId: invoice.Id,
      qboPaymentId: payment.Id,
      financialStatus: order.financialStatus,
      syncStatus: 'synced',
      lastError: null,
    })

    await writeSyncLog({
      shopId: shop.id,
      shopifyOrderId: sync.shopify_order_id,
      eventType: 'retry',
      status: 'success',
      message: `Retry successful: Created QB invoice ${invoice.Id}, payment ${payment.Id}`,
      payload: {},
    })

    return res.json({ success: true, message: 'Order synced successfully' })
  } catch (error) {
    const errorMsg = error?.message || String(error)

    await updateOrderSyncStatus({
      shopId: shop.id,
      shopifyOrderId: sync.shopify_order_id,
      qboCustomerId: sync.qbo_customer_id,
      qboInvoiceId: sync.qbo_invoice_id,
      qboPaymentId: sync.qbo_payment_id,
      financialStatus: sync.financial_status,
      syncStatus: 'failed',
      lastError: errorMsg,
    })

    await writeSyncLog({
      shopId: shop.id,
      shopifyOrderId: sync.shopify_order_id,
      eventType: 'retry',
      status: 'failed',
      message: `Retry failed: ${errorMsg}`,
      payload: {},
    })

    return res.status(422).json({ error: errorMsg })
  }
})

app.get('/api/logs', async (req, res) => {
  const db = await getDb()
  const logs = await db.all(
    `SELECT sl.*, s.shop_domain, os.qbo_invoice_id
     FROM sync_logs sl
     LEFT JOIN shops s ON s.id = sl.shop_id
     LEFT JOIN order_syncs os ON os.shop_id = sl.shop_id AND os.shopify_order_id = sl.shopify_order_id
     ORDER BY sl.created_at DESC
     LIMIT 500`,
  )
  return res.json({ logs })
})

app.get('/api/settings', async (req, res) => {
  const db = await getDb()
  const settings = await db.get('SELECT * FROM app_settings WHERE id = 1')
  
  if (!settings) {
    return res.json({
      settings: {
        shopifyDomain: '',
        shopifyApiKey: '',
        qboConnected: false,
        autoDecrementInventory: false,
      },
    })
  }

  return res.json({
    settings: {
      shopifyDomain: settings.shopify_domain || '',
      shopifyApiKey: settings.shopify_api_key ? '***' : '',
      qboConnected: Boolean(settings.qbo_connected),
      autoDecrementInventory: Boolean(settings.auto_decrement_inventory),
    },
  })
})

app.post('/api/settings', async (req, res) => {
  const { shopifyDomain, shopifyApiKey, autoDecrementInventory } = req.body

  const db = await getDb()
  
  const existing = await db.get('SELECT * FROM app_settings WHERE id = 1')
  
  if (existing) {
    await db.run(
      `UPDATE app_settings 
       SET shopify_domain = ?, 
           shopify_api_key = ?,
           auto_decrement_inventory = ?,
           updated_at = datetime('now')
       WHERE id = 1`,
      [
        shopifyDomain || existing.shopify_domain,
        shopifyApiKey && shopifyApiKey !== '***' ? shopifyApiKey : existing.shopify_api_key,
        autoDecrementInventory ? 1 : 0,
      ],
    )
  } else {
    await db.run(
      `INSERT INTO app_settings (id, shopify_domain, shopify_api_key, auto_decrement_inventory)
       VALUES (1, ?, ?, ?)`,
      [shopifyDomain || '', shopifyApiKey || '', autoDecrementInventory ? 1 : 0],
    )
  }

  return res.json({ success: true, message: 'Settings saved' })
})

app.post('/api/webhooks/shopify/orders-paid', async (req, res) => {
  const shopDomainHeader = req.get('x-shopify-shop-domain')
  const shopDomainBody = req.body?.shopDomain
  const shopDomain = String(shopDomainHeader || shopDomainBody || '').toLowerCase().trim()

  let shop = null
  let orderId = 'unknown'

  try {
    const plan = getActivePlanConfig()
    if (!shopDomain) {
      throw new Error('Missing shop domain in webhook')
    }

    const webhookIsValid = verifyShopifyWebhookHmac(req)
    if (!webhookIsValid && !ALLOW_DEV_WEBHOOK_WITHOUT_HMAC) {
      throw new Error('Invalid Shopify webhook HMAC')
    }

    shop = await getShopByDomain(shopDomain)
    if (!shop || !shop.is_installed) {
      throw new Error(`Shop not installed: ${shopDomain}`)
    }

    const order = await fetchShopifyOrderDetails(shop, req.body || {})
    orderId = String(order.orderId)

    const existing = await getOrderSyncByUniqueKey(shop.id, orderId)
    if (existing) {
      await writeSyncLog({
        shopId: shop.id,
        shopifyOrderId: orderId,
        eventType: 'orders/paid',
        status: 'skipped_duplicate',
        message: 'Duplicate webhook skipped (shop_id + shopify_order_id unique key)',
        payload: req.body,
      })

      return res.status(200).json({ success: true, duplicate: true })
    }

    if (order.financialStatus !== 'paid') {
      throw new Error('Order financial_status is not paid')
    }

    if (plan.orderLimitPerMonth != null) {
      const usedOrders = await countMonthlyOrderSyncs()
      if (usedOrders >= plan.orderLimitPerMonth) {
        throw new Error(
          `Starter plan monthly limit reached (${plan.orderLimitPerMonth} orders). Upgrade to Scale for unlimited orders.`,
        )
      }
    }

    // Check if QB is connected
    const qboConnected = Boolean(shop.qbo_access_token && shop.qbo_realm_id)

    if (!qboConnected) {
      // Save order in pending status if QB is not connected
      await createOrderSyncRecord({
        shopId: shop.id,
        shopifyOrderId: orderId,
        shopifyOrderName: order.orderName,
        qboCustomerId: null,
        qboInvoiceId: null,
        qboPaymentId: null,
        financialStatus: order.financialStatus,
        syncStatus: 'pending',
        lastError: 'QuickBooks is not connected. Connect QB in Settings to sync this order.',
      })

      await writeSyncLog({
        shopId: shop.id,
        shopifyOrderId: orderId,
        eventType: 'orders/paid',
        status: 'pending_qbo',
        message: 'Order received but QB is not connected. Please connect QB in Settings.',
        payload: req.body,
      })

      return res.status(202).json({ 
        success: true, 
        pending: true,
        message: 'Order saved. QB not connected - connect in Settings to sync.' 
      })
    }

    // Try to sync to QB
    try {
      await createOrderSyncRecord({
        shopId: shop.id,
        shopifyOrderId: orderId,
        shopifyOrderName: order.orderName,
        qboCustomerId: null,
        qboInvoiceId: null,
        qboPaymentId: null,
        financialStatus: order.financialStatus,
        syncStatus: 'processing',
        lastError: null,
      })

      const customer = await qboFindOrCreateCustomer(shop, order)
      const invoice = await qboCreateInvoice(shop, {
        order,
        customerId: customer.Id,
      })
      const payment = await qboCreatePayment(shop, {
        order,
        customerId: customer.Id,
        invoiceId: invoice.Id,
      })

      await updateOrderSyncStatus({
        shopId: shop.id,
        shopifyOrderId: orderId,
        qboCustomerId: customer.Id,
        qboInvoiceId: invoice.Id,
        qboPaymentId: payment.Id,
        financialStatus: order.financialStatus,
        syncStatus: 'synced',
        lastError: null,
      })

      await writeSyncLog({
        shopId: shop.id,
        shopifyOrderId: orderId,
        eventType: 'orders/paid',
        status: 'success',
        message: `Created QB customer ${customer.Id}, invoice ${invoice.Id}, payment ${payment.Id}`,
        payload: req.body,
      })

      console.log(`✓ Order #${orderId} synced successfully to QB (Invoice: ${invoice.Id})`)
      return res.status(201).json({ success: true })
    } catch (qboError) {
      // QB sync failed, save error but mark as retriable
      const errorMsg = qboError?.message || String(qboError)
      console.error(`✗ QB sync failed for order #${orderId}: ${errorMsg}`)

      await updateOrderSyncStatus({
        shopId: shop.id,
        shopifyOrderId: orderId,
        qboCustomerId: null,
        qboInvoiceId: null,
        qboPaymentId: null,
        financialStatus: order.financialStatus,
        syncStatus: 'failed',
        lastError: errorMsg,
      })

      await writeSyncLog({
        shopId: shop.id,
        shopifyOrderId: orderId,
        eventType: 'orders/paid',
        status: 'failed',
        message: `QB sync error: ${errorMsg}`,
        payload: req.body,
      })

      return res.status(422).json({ error: errorMsg })
    }
  } catch (error) {
    console.error(`✗ Webhook error for order #${orderId}: ${error?.message}`)

    if (shop && orderId !== 'unknown') {
      try {
        const existing = await getOrderSyncByUniqueKey(shop.id, orderId)
        if (existing) {
          await updateOrderSyncStatus({
            shopId: shop.id,
            shopifyOrderId: orderId,
            qboCustomerId: existing.qbo_customer_id,
            qboInvoiceId: existing.qbo_invoice_id,
            qboPaymentId: existing.qbo_payment_id,
            financialStatus: existing.financial_status,
            syncStatus: 'failed',
            lastError: error.message,
          })
        }
      } catch {
        // Log update failed, continue
      }
    }

    await writeSyncLog({
      shopId: shop?.id || null,
      shopifyOrderId: orderId,
      eventType: 'orders/paid',
      status: 'failed',
      message: error.message,
      payload: req.body,
    })

    return res.status(422).json({ error: error.message })
  }
})

app.post('/api/webhooks/shopify/refunds-create', async (req, res) => {
  const shopDomain = String(req.get('x-shopify-shop-domain') || req.body?.shopDomain || '').toLowerCase().trim()
  const shop = shopDomain ? await getShopByDomain(shopDomain) : null

  await writeSyncLog({
    shopId: shop?.id || null,
    shopifyOrderId: String(req.body?.order_id || req.body?.orderId || 'unknown'),
    eventType: 'refunds/create',
    status: 'queued',
    message: 'Refund sync queued for next phase',
    payload: req.body,
  })

  res.status(202).json({ success: true, message: 'Refund sync queued' })
})

app.post('/api/webhooks/shopify/app-uninstalled', async (req, res) => {
  try {
    const shopDomain = String(req.get('x-shopify-shop-domain') || req.body?.shop_domain || '').toLowerCase().trim()
    await markShopUninstalled(shopDomain)
    const shop = await getShopByDomain(shopDomain)

    await writeSyncLog({
      shopId: shop?.id || null,
      eventType: 'app/uninstalled',
      status: 'success',
      message: `Shop marked uninstalled: ${shopDomain}`,
      payload: req.body,
    })

    return res.status(204).send()
  } catch (error) {
    await writeSyncLog({
      eventType: 'app/uninstalled',
      status: 'failed',
      message: error.message,
      payload: req.body,
    })
    return res.status(500).json({ error: error.message })
  }
})

async function start() {
  await migrate()

  app.listen(port, () => {
    console.log(`Order2Books API running on port ${port}`)
  })
}

// Export app for serverless (Vercel)
module.exports = app

// Only start listening if running locally (not on Vercel)
if (!process.env.VERCEL) {
  start().catch((error) => {
    console.error('Failed to start server', error)
    process.exit(1)
  })
}
