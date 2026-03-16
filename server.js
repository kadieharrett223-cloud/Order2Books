const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { migrate, getDb } = require('./db')
const { verifyShopifyWebhookHmac: verifyWebhookHmac, ensureWebhookSignature: ensureWebhookSigUtil } = require('./lib/verifyShopifyWebhook')
require('dotenv').config()

const app = express()
const port = Number(process.env.PORT || 4000)

// APP_URL - use from env, fallback to localhost for dev, or infer from Vercel
let APP_URL = process.env.APP_URL
const VERCEL_PRODUCTION_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : ''

if (APP_URL && VERCEL_PRODUCTION_URL) {
  const normalizedAppUrl = String(APP_URL).trim().replace(/\/+$/, '')
  const normalizedProdUrl = String(VERCEL_PRODUCTION_URL).trim().replace(/\/+$/, '')
  const looksLikePreview = /-[a-z0-9]+-[a-z0-9-]+\.vercel\.app$/i.test(normalizedAppUrl)
  if (looksLikePreview && normalizedAppUrl.toLowerCase() !== normalizedProdUrl.toLowerCase()) {
    APP_URL = normalizedProdUrl
  }
}

if (APP_URL && /admin\.shopify\.com/i.test(APP_URL)) {
  APP_URL = ''
}

if (APP_URL) {
  APP_URL = String(APP_URL).trim().replace(/\/+$/, '')
}

if (!APP_URL) {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    APP_URL = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  } else if (process.env.VERCEL_URL) {
    APP_URL = `https://${process.env.VERCEL_URL}`
  } else {
    APP_URL = `http://localhost:${port}`
  }
}

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || ''
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || ''
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10'
const SHOPIFY_SCOPES = process.env.SHOPIFY_SCOPES || 'read_orders'
const STATE_SECRET = process.env.STATE_SECRET || 'dev-state-secret'

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || ''
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || ''
const QBO_REDIRECT_URI = String(process.env.QBO_REDIRECT_URI || '').trim()
const QBO_SCOPES = 'com.intuit.quickbooks.accounting'
const QBO_ENV_INPUT = String(process.env.QBO_ENV || process.env.QBO_ENVIRONMENT || '').toLowerCase().trim()
const QBO_ENV = QBO_ENV_INPUT === 'production' ? 'production' : 'sandbox'
const QBO_MINOR_VERSION = process.env.QBO_MINOR_VERSION || '75'
const QBO_ITEM_REF = process.env.QBO_ITEM_REF || '1'
const QBO_MISC_ITEM_REF = process.env.QBO_MISC_ITEM_REF || QBO_ITEM_REF
const CAPTURE_MODES = {
  AUTO: 'auto',
  MANUAL: 'manual',
}
let activePlanKey = String(process.env.APP_PLAN || 'starter').toLowerCase() === 'scale' ? 'scale' : 'starter'
const REQUIRE_SHOPIFY_SESSION = process.env.REQUIRE_SHOPIFY_SESSION === 'true'

const PLAN_CONFIG = {
  starter: {
    key: 'starter',
    name: 'Starter',
    priceMonthly: 9.99,
    orderLimitPerMonth: 100,
    features: [
      'Up to 100 auto-invoice orders / month',
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
const mappingScanCooldownByShopId = new Map()
const mappingScanInProgressByShopId = new Map()

const COMPLIANCE_WEBHOOKS = [
  {
    topic: 'customers/data_request',
    path: '/api/webhooks/customers-data-request',
  },
  {
    topic: 'customers/redact',
    path: '/api/webhooks/customers-redact',
  },
  {
    topic: 'shop/redact',
    path: '/api/webhooks/shop-redact',
  },
]

app.use(cors())
app.use(
  express.json({
    verify: (req, res, buffer) => {
      req.rawBody = buffer
    },
  }),
)

function getSessionTokenFromRequest(req) {
  const authHeader = String(req.get('authorization') || '')
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim()
  }

  return String(req.get('x-shopify-session-token') || '').trim()
}

function tryAttachShopDomainFromSessionToken(req) {
  const token = getSessionTokenFromRequest(req)
  if (!token || !SHOPIFY_API_SECRET || !SHOPIFY_API_KEY) {
    return false
  }

  try {
    const payload = jwt.verify(token, SHOPIFY_API_SECRET, {
      algorithms: ['HS256'],
      audience: SHOPIFY_API_KEY,
    })

    req.shopifySession = payload
    const dest = String(payload?.dest || '')
    const shopDomain = dest.replace(/^https?:\/\//, '').toLowerCase().trim()
    if (validateShopDomain(shopDomain)) {
      req.shopDomainFromSession = shopDomain
      return true
    }
  } catch {
  }

  return false
}

function verifyShopifySession(req, res, next) {
  const path = req.path || ''
  if (path.startsWith('/webhooks/') || path.includes('/webhooks/') || path.startsWith('/auth/') || path === '/health') {
    tryAttachShopDomainFromSessionToken(req)
    return next()
  }

  const allowTokenlessPaths = new Set(['/settings', '/debug/qbo-status', '/me'])
  if (allowTokenlessPaths.has(path)) {
    tryAttachShopDomainFromSessionToken(req)

    if (!req.shopDomainFromSession) {
      const resolvedShopDomain = resolveShopDomainFromRequest(req)
      if (resolvedShopDomain) {
        req.shopDomainFromSession = resolvedShopDomain
      }
    }

    return next()
  }

  const token = getSessionTokenFromRequest(req)
  if (!token) {
    const fallbackShop = String(req.query?.shop || '').toLowerCase().trim()
    if (validateShopDomain(fallbackShop)) {
      req.shopDomainFromSession = fallbackShop
      return next()
    }

    if (REQUIRE_SHOPIFY_SESSION) {
      return res.status(401).json({ error: 'Missing Shopify session token' })
    }
    return next()
  }

  if (!SHOPIFY_API_SECRET || !SHOPIFY_API_KEY) {
    return res.status(500).json({ error: 'Shopify API credentials are not configured' })
  }

  try {
    if (!tryAttachShopDomainFromSessionToken(req)) {
      return res.status(401).json({ error: 'Invalid Shopify session token' })
    }
    return next()
  } catch {
    return res.status(401).json({ error: 'Invalid Shopify session token' })
  }
}

// DEBUG: Public endpoint to check environment configuration (no Shopify session required)
app.get('/api/debug/env-config', async (req, res) => {
  return res.json({
    environment: process.env.NODE_ENV,
    qbo_client_id_set: Boolean(QBO_CLIENT_ID),
    qbo_client_secret_set: Boolean(QBO_CLIENT_SECRET),
    qbo_redirect_uri_set: Boolean(QBO_REDIRECT_URI),
    qbo_redirect_uri: QBO_REDIRECT_URI || '(not set)',
    qbo_environment: QBO_ENV,
    shopify_api_key_set: Boolean(SHOPIFY_API_KEY),
    shopify_api_secret_set: Boolean(SHOPIFY_API_SECRET),
    postgres_url_set: Boolean(process.env.POSTGRES_URL),
    database_driver: process.env.POSTGRES_URL ? 'postgres' : 'sqlite',
    app_url: APP_URL,
  })
})

// DEBUG: Check what's actually in the database for a shop
app.get('/api/debug/shop-qbo-status/:shopDomain', async (req, res) => {
  try {
    const shopDomain = String(req.params.shopDomain || '').toLowerCase().trim()
    if (!validateShopDomain(shopDomain)) {
      return res.status(400).json({ error: 'Invalid shop domain' })
    }
    
    const db = await getDb()
    const shop = await db.get('SELECT * FROM shops WHERE shop_domain = ?', [shopDomain])
    
    if (!shop) {
      return res.json({
        shop_domain: shopDomain,
        found: false,
        message: 'Shop not found in database'
      })
    }
    
    return res.json({
      shop_domain: shop.shop_domain,
      found: true,
      is_installed: Boolean(shop.is_installed),
      has_qbo_realm_id: Boolean(shop.qbo_realm_id),
      has_qbo_access_token: Boolean(shop.qbo_access_token),
      has_qbo_refresh_token: Boolean(shop.qbo_refresh_token),
      qbo_realm_id: shop.qbo_realm_id || null,
      qbo_token_expires_at: shop.qbo_token_expires_at || null,
      qbo_sync_cutoff_at: shop.qbo_sync_cutoff_at || null,
      message: `Shop has ${Boolean(shop.qbo_realm_id && shop.qbo_access_token) ? 'QBO tokens' : 'NO QBO tokens'}`
    })
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
})

// DEBUG: Clear QBO tokens for a shop (public endpoint for troubleshooting)
app.post('/api/debug/clear-qbo-tokens/:shopDomain', async (req, res) => {
  try {
    const shopDomain = String(req.params.shopDomain || '').toLowerCase().trim()
    if (!validateShopDomain(shopDomain)) {
      return res.status(400).json({ error: 'Invalid shop domain' })
    }
    
    const db = await getDb()
    const shop = await db.get('SELECT * FROM shops WHERE shop_domain = ?', [shopDomain])
    
    if (!shop) {
      return res.status(404).json({ error: 'Shop not found' })
    }
    
    await db.run(
      `UPDATE shops
       SET qbo_realm_id = NULL,
           qbo_access_token = NULL,
           qbo_refresh_token = NULL,
           qbo_token_expires_at = NULL,
           qbo_sync_cutoff_at = NULL,
           updated_at = ?
       WHERE id = ?`,
      [nowIso(), shop.id],
    )
    
    console.log(`[DEBUG] Cleared QBO tokens for shop: ${shopDomain}`)
    
    return res.json({
      success: true,
      message: `QBO tokens cleared for ${shopDomain}`,
      shop_domain: shopDomain
    })
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
})

app.use('/api', verifyShopifySession)

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

function getRequestOrigin(req) {
  const forwardedProto = String(req?.get?.('x-forwarded-proto') || '').split(',')[0].trim()
  const forwardedHost = String(req?.get?.('x-forwarded-host') || '').split(',')[0].trim()
  const host = forwardedHost || String(req?.get?.('host') || '').trim()
  const proto = forwardedProto || (process.env.VERCEL ? 'https' : 'http')

  if (host) {
    return `${proto}://${host}`
  }

  return APP_URL
}

function buildShopifyCallbackUrl(req) {
  return `${getRequestOrigin(req)}/api/auth/shopify/callback`
}

function buildAppUrl(pathname) {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  return `${APP_URL}${normalizedPath}`
}

function buildQboCallbackUrl(req) {
  if (QBO_REDIRECT_URI) {
    return QBO_REDIRECT_URI
  }
  return buildAppUrl('/api/auth/qbo/callback')
}

function buildAppUrlFromRequest(req, pathname) {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  const requestOrigin = String(getRequestOrigin(req) || '').replace(/\/+$/, '')
  const envOrigin = String(APP_URL || '').replace(/\/+$/, '')
  const baseUrl = /admin\.shopify\.com/i.test(envOrigin) || !envOrigin ? requestOrigin : envOrigin
  return `${baseUrl}${normalizedPath}`
}

function buildEmbeddedShopifyAppUrl(shopDomain, query = {}) {
  const normalizedShopDomain = String(shopDomain || '').trim().toLowerCase()
  if (!validateShopDomain(normalizedShopDomain) || !SHOPIFY_API_KEY) {
    return ''
  }

  const storeHandle = normalizedShopDomain.replace(/\.myshopify\.com$/i, '')
  if (!storeHandle) {
    return ''
  }

  const qs = new URLSearchParams(query).toString()
  return `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}/apps/${encodeURIComponent(SHOPIFY_API_KEY)}${qs ? `?${qs}` : ''}`
}

function shouldRedirectToCanonicalAppOrigin(req) {
  const requestOrigin = String(getRequestOrigin(req) || '').replace(/\/+$/, '')
  const appOrigin = String(APP_URL || '').replace(/\/+$/, '')
  if (!requestOrigin || !appOrigin) {
    return false
  }

  return requestOrigin.toLowerCase() !== appOrigin.toLowerCase()
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

function getCookieValue(req, cookieName) {
  const rawCookie = String(req?.get?.('cookie') || '')
  if (!rawCookie) {
    return ''
  }

  const needle = `${cookieName}=`.toLowerCase()
  for (const segment of rawCookie.split(';')) {
    const pair = String(segment || '').trim()
    if (!pair.toLowerCase().startsWith(needle)) {
      continue
    }

    const value = pair.slice(cookieName.length + 1)
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  return ''
}

function resolveShopDomainFromSignedState(stateValue) {
  const rawState = String(stateValue || '').trim()
  if (!rawState) {
    return ''
  }

  try {
    const payload = verifySignedState(rawState)
    const signedStateShop = String(payload?.shop || '').toLowerCase().trim()
    if (validateShopDomain(signedStateShop)) {
      return signedStateShop
    }
  } catch {
  }

  if (validateShopDomain(rawState)) {
    return rawState.toLowerCase()
  }

  return ''
}

function resolveShopDomainFromRequest(req) {
  const shopFromSession = String(req?.shopDomainFromSession || '').toLowerCase().trim()
  if (validateShopDomain(shopFromSession)) {
    return shopFromSession
  }

  const shopFromSignedState = resolveShopDomainFromSignedState(req?.query?.state)
  if (validateShopDomain(shopFromSignedState)) {
    return shopFromSignedState
  }

  const shopFromCookie = String(getCookieValue(req, 'order2books_shop') || '').toLowerCase().trim()
  if (validateShopDomain(shopFromCookie)) {
    return shopFromCookie
  }

  const shopFromQuery = String(req?.query?.shop || '').toLowerCase().trim()
  if (validateShopDomain(shopFromQuery)) {
    return shopFromQuery
  }

  return ''
}

function setActiveShopCookie(res, shopDomain) {
  const normalizedShopDomain = String(shopDomain || '').toLowerCase().trim()
  if (!validateShopDomain(normalizedShopDomain)) {
    return
  }

  res.cookie('order2books_shop', normalizedShopDomain, {
    httpOnly: false,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
}

function extractShopDomainFromHostParam(hostParam) {
  const raw = String(hostParam || '').trim()
  if (!raw) {
    return ''
  }

  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    const normalized = decoded.trim().toLowerCase()

    if (validateShopDomain(normalized)) {
      return normalized
    }

    const storeMatch = normalized.match(/store\/(\w[\w-]*)/)
    if (storeMatch && storeMatch[1]) {
      return `${storeMatch[1].toLowerCase()}.myshopify.com`
    }

    const subdomainMatch = normalized.match(/([\w-]+\.myshopify\.com)/)
    if (subdomainMatch && subdomainMatch[1]) {
      return subdomainMatch[1].toLowerCase()
    }
  } catch {
  }

  return ''
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

async function ensureShopRecordByDomain(shopDomain) {
  const normalizedShopDomain = String(shopDomain || '').toLowerCase().trim()
  if (!validateShopDomain(normalizedShopDomain)) {
    return null
  }

  const db = await getDb()
  await db.run(
    `INSERT INTO shops (shop_domain, is_installed, created_at, updated_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(shop_domain) DO UPDATE SET
       is_installed = 1,
       updated_at = excluded.updated_at`,
    [normalizedShopDomain, nowIso(), nowIso()],
  )

  const shop = await db.get(`SELECT * FROM shops WHERE shop_domain = ?`, [normalizedShopDomain])
  await persistPrimaryShopifyDomain(normalizedShopDomain)
  return shop
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

async function getAppSettingsRecord() {
  const db = await getDb()
  return db.get('SELECT * FROM app_settings WHERE id = 1')
}

async function persistPrimaryShopifyDomain(shopDomain) {
  const normalized = String(shopDomain || '').toLowerCase().trim()
  if (!validateShopDomain(normalized)) {
    return
  }

  const db = await getDb()
  const existing = await db.get('SELECT id FROM app_settings WHERE id = 1')
  if (existing) {
    await db.run(
      `UPDATE app_settings
       SET shopify_domain = ?,
           updated_at = ?
       WHERE id = 1`,
      [normalized, nowIso()],
    )
    return
  }

  await db.run(
    `INSERT INTO app_settings (id, shopify_domain, created_at, updated_at)
     VALUES (1, ?, ?, ?)`,
    [normalized, nowIso(), nowIso()],
  )
}

function normalizeCaptureMode(value) {
  const captureMode = String(value || '').toLowerCase().trim()
  if (captureMode === CAPTURE_MODES.MANUAL) {
    return CAPTURE_MODES.MANUAL
  }
  return CAPTURE_MODES.AUTO
}

async function getCaptureMode() {
  const settings = await getAppSettingsRecord()
  return normalizeCaptureMode(settings?.capture_mode)
}

async function getActiveInstalledShop(req) {
  const db = await getDb()
  const requestedShopDomain = resolveShopDomainFromRequest(req)

  if (!requestedShopDomain) {
    const settings = await db.get('SELECT * FROM app_settings WHERE id = 1')
    const fallbackShopDomain = String(settings?.shopify_domain || '').toLowerCase().trim()

    if (validateShopDomain(fallbackShopDomain)) {
      const preferredShop = await db.get(
        `SELECT *
         FROM shops
         WHERE shop_domain = ?
         ORDER BY is_installed DESC, datetime(updated_at) DESC
         LIMIT 1`,
        [fallbackShopDomain],
      )

      if (preferredShop && (preferredShop.is_installed || preferredShop.shopify_access_token)) {
        return preferredShop
      }
    }

    const mostRecentInstalledShop = await db.get(
      `SELECT *
       FROM shops
       WHERE is_installed = 1
       ORDER BY datetime(updated_at) DESC
       LIMIT 1`,
    )

    if (mostRecentInstalledShop) {
      return mostRecentInstalledShop
    }

    const mostRecentTokenizedShop = await db.get(
      `SELECT *
       FROM shops
       WHERE shopify_access_token IS NOT NULL AND shopify_access_token <> ''
       ORDER BY datetime(updated_at) DESC
       LIMIT 1`,
    )

    return mostRecentTokenizedShop || null
  }

  const installedRequestedShop = await db.get(
    `SELECT * FROM shops WHERE shop_domain = ? AND is_installed = 1 ORDER BY datetime(updated_at) DESC LIMIT 1`,
    [requestedShopDomain],
  )

  if (installedRequestedShop) {
    return installedRequestedShop
  }

  const tokenizedRequestedShop = await db.get(
    `SELECT * FROM shops WHERE shop_domain = ? ORDER BY datetime(updated_at) DESC LIMIT 1`,
    [requestedShopDomain],
  )

  if (tokenizedRequestedShop && tokenizedRequestedShop.shopify_access_token) {
    return tokenizedRequestedShop
  }

  return null
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

async function updateQboTokensForShop({ shopId, realmId, accessToken, refreshToken, expiresAt, syncCutoffAt = null }) {
  const db = await getDb()
  await db.run(
    `UPDATE shops
     SET qbo_realm_id = ?,
         qbo_access_token = ?,
         qbo_refresh_token = ?,
         qbo_token_expires_at = ?,
         qbo_sync_cutoff_at = COALESCE(?, qbo_sync_cutoff_at),
         updated_at = ?
     WHERE id = ?`,
    [realmId, accessToken, refreshToken, expiresAt, syncCutoffAt, nowIso(), shopId],
  )
}

async function clearQboTokensForShop(shopId) {
  const db = await getDb()
  await db.run(
    `UPDATE shops
     SET qbo_realm_id = NULL,
         qbo_access_token = NULL,
         qbo_refresh_token = NULL,
         qbo_token_expires_at = NULL,
         qbo_sync_cutoff_at = NULL,
         updated_at = ?
     WHERE id = ?`,
    [nowIso(), shopId],
  )
}

async function clearQboTokensForShopDomain(shopDomain) {
  const normalizedShopDomain = String(shopDomain || '').toLowerCase().trim()
  if (!validateShopDomain(normalizedShopDomain)) {
    return 0
  }

  const db = await getDb()
  const result = await db.run(
    `UPDATE shops
     SET qbo_realm_id = NULL,
         qbo_access_token = NULL,
         qbo_refresh_token = NULL,
         qbo_token_expires_at = NULL,
         qbo_sync_cutoff_at = NULL,
         updated_at = ?
     WHERE shop_domain = ?`,
    [nowIso(), normalizedShopDomain],
  )

  return Number(result?.changes || 0)
}

function getOrderEligibleTimestamp(order) {
  return String(order?.createdAt || order?.paidAt || '').trim()
}

function isOrderEligibleForQboSync(shop, order) {
  const cutoffRaw = String(shop?.qbo_sync_cutoff_at || '').trim()
  if (!cutoffRaw) {
    return true
  }

  const cutoffMs = new Date(cutoffRaw).getTime()
  const orderMs = new Date(getOrderEligibleTimestamp(order)).getTime()

  if (Number.isNaN(cutoffMs) || Number.isNaN(orderMs)) {
    return true
  }

  return orderMs >= cutoffMs
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
  financialStatus,
  syncStatus,
  lastError,
}) {
  const db = await getDb()
  await db.run(
    `INSERT INTO order_syncs (
      shop_id, shopify_order_id, shopify_order_name,
      qbo_customer_id, qbo_invoice_id,
      financial_status, sync_status, last_error,
      synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      shopId,
      String(shopifyOrderId),
      shopifyOrderName,
      qboCustomerId,
      qboInvoiceId,
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
  financialStatus,
  syncStatus,
  lastError,
}) {
  const db = await getDb()
  await db.run(
    `UPDATE order_syncs
     SET qbo_customer_id = ?,
         qbo_invoice_id = ?,
         financial_status = ?,
         sync_status = ?,
         last_error = ?,
         synced_at = ?,
         updated_at = ?
     WHERE shop_id = ? AND shopify_order_id = ?`,
    [
      qboCustomerId,
      qboInvoiceId,
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

async function shopifyAdminRequest({ shopDomain, accessToken, method, path, body }) {
  const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    method,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Shopify Admin API error (${response.status}): ${message}`)
  }

  if (response.status === 204) {
    return null
  }

  return response.json()
}

function isUnsupportedComplianceTopicError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('could not find the webhook topic')
}

async function registerComplianceWebhooks({ shopDomain, accessToken }) {
  const existingResponse = await shopifyAdminRequest({
    shopDomain,
    accessToken,
    method: 'GET',
    path: '/webhooks.json',
  })

  const existingWebhooks = existingResponse?.webhooks || []

  for (const webhook of COMPLIANCE_WEBHOOKS) {
    const callbackUrl = buildAppUrl(webhook.path)
    const existingWebhook = existingWebhooks.find((item) => item.topic === webhook.topic)

    if (existingWebhook) {
      const needsUpdate = existingWebhook.address !== callbackUrl || String(existingWebhook.format || '').toLowerCase() !== 'json'

      if (!needsUpdate) {
        continue
      }

      try {
        await shopifyAdminRequest({
          shopDomain,
          accessToken,
          method: 'PUT',
          path: `/webhooks/${existingWebhook.id}.json`,
          body: {
            webhook: {
              id: existingWebhook.id,
              address: callbackUrl,
              format: 'json',
            },
          },
        })
      } catch (error) {
        if (isUnsupportedComplianceTopicError(error)) {
          console.warn(`Skipping unsupported compliance webhook topic: ${webhook.topic}`)
          continue
        }
        throw error
      }

      continue
    }

    try {
      await shopifyAdminRequest({
        shopDomain,
        accessToken,
        method: 'POST',
        path: '/webhooks.json',
        body: {
          webhook: {
            topic: webhook.topic,
            address: callbackUrl,
            format: 'json',
          },
        },
      })
    } catch (error) {
      if (isUnsupportedComplianceTopicError(error)) {
        console.warn(`Skipping unsupported compliance webhook topic: ${webhook.topic}`)
        continue
      }
      throw error
    }
  }
}

async function exchangeQboCodeForToken({ code, redirectUri }) {
  if (!code) {
    throw new Error('Missing authorization code from Intuit OAuth callback')
  }
  
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri || buildQboCallbackUrl(),
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

async function getQboCompanyName(shop) {
  if (!shop?.qbo_realm_id || (!shop?.qbo_access_token && !shop?.qbo_refresh_token)) {
    return ''
  }

  try {
    const response = await qboRequest({
      shop,
      method: 'GET',
      path: `/v3/company/${shop.qbo_realm_id}/companyinfo/${shop.qbo_realm_id}?minorversion=${QBO_MINOR_VERSION}`,
    })

    return String(response?.CompanyInfo?.CompanyName || response?.CompanyInfo?.LegalName || '').trim()
  } catch (error) {
    console.warn('Unable to fetch QuickBooks company name:', error?.message || String(error))
    return ''
  }
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

async function qboQuery(shop, query) {
  return qboRequest({
    shop,
    method: 'GET',
    path: `/v3/company/${shop.qbo_realm_id}/query?query=${encodeURIComponent(query)}&minorversion=${QBO_MINOR_VERSION}`,
  })
}

async function qboFindItemBySku(shop, sku) {
  if (!sku) return null

  const query = `select * from Item where Sku = '${String(sku).replace(/'/g, "\\'")}' maxresults 1`
  const response = await qboQuery(shop, query)
  return response.QueryResponse?.Item?.[0] || null
}

async function qboFindItemByName(shop, name) {
  if (!name) return null

  const safeName = String(name).trim().replace(/'/g, "\\'")
  if (!safeName) return null

  const exactResponse = await qboQuery(shop, `select * from Item where Name = '${safeName}' maxresults 1`)
  const exactItem = exactResponse.QueryResponse?.Item?.[0] || null
  if (exactItem) {
    return exactItem
  }

  const startsWithResponse = await qboQuery(shop, `select * from Item where Name like '${safeName}%' maxresults 1`)
  return startsWithResponse.QueryResponse?.Item?.[0] || null
}

async function qboSearchItems(shop, searchTerm) {
  // Search QB items by name or SKU, return up to 20 results
  if (!searchTerm || String(searchTerm).trim().length === 0) {
    return []
  }

  const safeTerm = String(searchTerm).trim().replace(/'/g, "\\'")
  
  // Search by name (starts with match, most relevant)
  const nameQuery = `select * from Item where Name like '${safeTerm}%' and Active = true maxresults 20`
  const nameResponse = await qboQuery(shop, nameQuery).catch(() => ({ QueryResponse: {} }))
  const nameMatches = nameResponse.QueryResponse?.Item || []

  // Search by SKU (exact and partial)
  const skuQuery = `select * from Item where Sku like '%${safeTerm}%' and Active = true maxresults 20`
  const skuResponse = await qboQuery(shop, skuQuery).catch(() => ({ QueryResponse: {} }))
  const skuMatches = skuResponse.QueryResponse?.Item || []

  // Combine and deduplicate
  const combined = [...nameMatches, ...skuMatches]
  const seen = new Set()
  const results = []
  
  for (const item of combined) {
    if (!seen.has(item.Id)) {
      seen.add(item.Id)
      results.push({
        id: item.Id,
        name: item.Name,
        sku: item.Sku || '',
        type: item.Type,
      })
    }
  }

  return results.slice(0, 20)
}

async function qboFindIncomeAccount(shop) {
  const queries = [
    `select * from Account where AccountType = 'Income' and Active = true maxresults 1`,
    `select * from Account where AccountSubType = 'SalesOfProductIncome' and Active = true maxresults 1`,
    `select * from Account where Classification = 'Revenue' and Active = true maxresults 1`,
  ]

  for (const query of queries) {
    const response = await qboQuery(shop, query)
    const account = response.QueryResponse?.Account?.[0] || null

    if (account?.Id) {
      return account
    }
  }

  return null
}

function buildQboItemName(line) {
  const title = String(line.title || 'Shopify Item').trim() || 'Shopify Item'
  const skuSuffix = line.sku ? ` (${line.sku})` : ''
  return `${title}${skuSuffix}`.slice(0, 100)
}

async function qboCreateItemFromShopifyLine(shop, line) {
  const incomeAccount = await qboFindIncomeAccount(shop)
  if (!incomeAccount?.Id) {
    throw new Error('No QuickBooks income account found for automatic item creation')
  }

  const payload = {
    Name: buildQboItemName(line),
    Sku: line.sku || undefined,
    Type: 'NonInventory',
    IncomeAccountRef: { value: incomeAccount.Id },
    Description: line.title || 'Created from Shopify product sync',
    Active: true,
    Taxable: false,
  }

  const response = await qboRequest({
    shop,
    method: 'POST',
    path: `/v3/company/${shop.qbo_realm_id}/item?minorversion=${QBO_MINOR_VERSION}`,
    body: payload,
  })

  return response.Item || null
}

function buildMappingKey(line) {
  return (
    line.variantId ||
    line.productId ||
    (line.sku ? `sku:${String(line.sku).toLowerCase()}` : null) ||
    `title:${String(line.title || '').toLowerCase()}`
  )
}

async function getMappingByLine(shopId, line) {
  const mappingKey = buildMappingKey(line)
  const db = await getDb()

  return db.get(
    `SELECT *
     FROM product_mappings
     WHERE shop_id = ? AND mapping_key = ?`,
    [shopId, mappingKey],
  )
}

async function upsertProductMapping({ shopId, line, qboItemId, qboItemName, mappingSource, status }) {
  const mappingKey = buildMappingKey(line)
  const db = await getDb()

  await db.run(
    `INSERT INTO product_mappings (
      shop_id,
      mapping_key,
      shopify_product_id,
      shopify_variant_id,
      shopify_sku,
      shopify_title,
      qbo_item_id,
      qbo_item_name,
      mapping_source,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, mapping_key) DO UPDATE SET
      shopify_product_id = excluded.shopify_product_id,
      shopify_variant_id = excluded.shopify_variant_id,
      shopify_sku = excluded.shopify_sku,
      shopify_title = excluded.shopify_title,
      qbo_item_id = excluded.qbo_item_id,
      qbo_item_name = excluded.qbo_item_name,
      mapping_source = excluded.mapping_source,
      status = excluded.status,
      updated_at = excluded.updated_at`,
    [
      shopId,
      mappingKey,
      line.productId || null,
      line.variantId || null,
      line.sku || null,
      line.title || 'Shopify Item',
      qboItemId || null,
      qboItemName || null,
      mappingSource,
      status,
      nowIso(),
      nowIso(),
    ],
  )
}

async function qboResolveItemRef(shop, line) {
  const existingMapping = await getMappingByLine(shop.id, line)
  if (existingMapping?.status === 'mapped' && existingMapping.qbo_item_id) {
    return {
      value: existingMapping.qbo_item_id,
      name: existingMapping.qbo_item_name || 'Mapped Item',
      mapped: true,
      source: 'saved',
    }
  }

  const mappedBySku = await qboFindItemBySku(shop, line.sku)
  if (mappedBySku?.Id) {
    await upsertProductMapping({
      shopId: shop.id,
      line,
      qboItemId: mappedBySku.Id,
      qboItemName: mappedBySku.Name,
      mappingSource: 'sku',
      status: 'mapped',
    })

    return {
      value: mappedBySku.Id,
      name: mappedBySku.Name,
      mapped: true,
      source: 'sku',
    }
  }

  const mappedByName = await qboFindItemByName(shop, line.title)
  if (mappedByName?.Id) {
    await upsertProductMapping({
      shopId: shop.id,
      line,
      qboItemId: mappedByName.Id,
      qboItemName: mappedByName.Name,
      mappingSource: 'name',
      status: 'mapped',
    })

    return {
      value: mappedByName.Id,
      name: mappedByName.Name,
      mapped: true,
      source: 'name',
    }
  }

  const settings = await getAppSettingsRecord()
  const autoCreateQboItems = settings?.auto_create_qbo_items !== 0

  if (autoCreateQboItems) {
    try {
      const createdItem = await qboCreateItemFromShopifyLine(shop, line)
      if (createdItem?.Id) {
        await upsertProductMapping({
          shopId: shop.id,
          line,
          qboItemId: createdItem.Id,
          qboItemName: createdItem.Name,
          mappingSource: 'auto-created',
          status: 'mapped',
        })

        return {
          value: createdItem.Id,
          name: createdItem.Name,
          mapped: true,
          source: 'auto-created',
        }
      }
    } catch {
      // Fall back to misc item when automatic creation is unavailable.
    }
  }

  await upsertProductMapping({
    shopId: shop.id,
    line,
    qboItemId: null,
    qboItemName: null,
    mappingSource: 'fallback',
    status: 'needs_attention',
  })

  return {
    value: QBO_MISC_ITEM_REF,
    name: 'Misc Item',
    mapped: false,
    source: 'fallback',
  }
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

async function fetchShopifyProducts(shop, limit = 100) {
  const response = await fetch(
    `https://${shop.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=${Number(limit)}`,
    {
      headers: {
        'X-Shopify-Access-Token': shop.shopify_access_token,
        'Content-Type': 'application/json',
      },
    },
  )

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Failed fetching Shopify products: ${message}`)
  }

  const data = await response.json()
  return Array.isArray(data?.products) ? data.products : []
}

function mapShopifyProductVariant(product, variant) {
  return {
    title: variant.title && variant.title !== 'Default Title' ? `${product.title} - ${variant.title}` : product.title,
    sku: variant.sku || null,
    variantTitle: variant.title || null,
    productId: product.id ? String(product.id) : null,
    variantId: variant.id ? String(variant.id) : null,
    quantity: 1,
    price: Number(variant.price || 0),
  }
}

async function runMappingScanForShop(shop) {
  if (!shop?.id || !shop?.shopify_access_token || !shop?.qbo_realm_id) {
    return
  }

  const products = await fetchShopifyProducts(shop, 100)
  let mappedCount = 0
  let needsAttentionCount = 0

  for (const product of products) {
    for (const variant of product.variants || []) {
      const line = mapShopifyProductVariant(product, variant)
      const resolvedItem = await qboResolveItemRef(shop, line)

      if (resolvedItem.mapped) {
        mappedCount += 1
      } else {
        needsAttentionCount += 1
      }
    }
  }

  await writeSyncLog({
    shopId: shop.id,
    eventType: 'mapping/scan',
    status: 'success',
    message: `Mapping scan complete. Auto mapped: ${mappedCount}, needs attention: ${needsAttentionCount}`,
    payload: { mappedCount, needsAttentionCount },
  })
}

function triggerMappingScan(shop, { force = false } = {}) {
  if (!shop?.id || !shop?.shopify_access_token || !shop?.qbo_realm_id || (!shop?.qbo_access_token && !shop?.qbo_refresh_token)) {
    return false
  }

  if (mappingScanInProgressByShopId.get(shop.id)) {
    return false
  }

  if (!force) {
    const cooldownMs = 2 * 60 * 1000
    const now = Date.now()
    const lastTriggeredAt = Number(mappingScanCooldownByShopId.get(shop.id) || 0)
    if (Number.isFinite(lastTriggeredAt) && now - lastTriggeredAt <= cooldownMs) {
      return false
    }
    mappingScanCooldownByShopId.set(shop.id, now)
  } else {
    mappingScanCooldownByShopId.set(shop.id, Date.now())
  }

  mappingScanInProgressByShopId.set(shop.id, true)

  Promise.resolve()
    .then(() => runMappingScanForShop(shop))
    .catch((error) => {
      console.error('Mapping scan failed:', error)
      writeSyncLog({
        shopId: shop.id,
        eventType: 'mapping/scan',
        status: 'failed',
        message: `Mapping scan failed: ${error?.message || String(error)}`,
        payload: { error: error?.message || String(error) },
      }).catch(() => {
      })
    })
    .finally(() => {
      mappingScanInProgressByShopId.set(shop.id, false)
      mappingScanCooldownByShopId.set(shop.id, Date.now())
    })

  return true
}

function buildQboSalesItemLine({ amount, description, quantity, unitPrice, itemRef }) {
  return {
    Amount: Number(Number(amount || 0).toFixed(2)),
    Description: description,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      Qty: quantity,
      UnitPrice: Number(Number(unitPrice || 0).toFixed(2)),
      ItemRef: { value: itemRef },
    },
  }
}

async function mapShopifyOrderToQboInvoiceLines(shop, order) {
  const lines = []

  for (const line of order.lineItems || []) {
    const quantity = Number(line.quantity || 1)
    const unitPrice = Number(line.price || 0)
    const amount = Number((quantity * unitPrice).toFixed(2))
    const resolvedItem = await qboResolveItemRef(shop, line)
    const descriptionParts = [line.title || 'Shopify Item']

    if (!resolvedItem.mapped) {
      if (line.sku) {
        descriptionParts.push(`SKU: ${line.sku}`)
      }
      if (line.variantTitle) {
        descriptionParts.push(`Variant: ${line.variantTitle}`)
      }
    }

    lines.push(
      buildQboSalesItemLine({
        amount,
        description: descriptionParts.join(' • '),
        quantity,
        unitPrice,
        itemRef: resolvedItem.value,
      }),
    )
  }

  if (Number(order.shipping || 0) > 0) {
    lines.push(
      buildQboSalesItemLine({
        amount: Number(order.shipping),
        description: 'Shipping',
        quantity: 1,
        unitPrice: Number(order.shipping),
        itemRef: QBO_MISC_ITEM_REF,
      }),
    )
  }

  if (Number(order.tax || 0) > 0) {
    lines.push(
      buildQboSalesItemLine({
        amount: Number(order.tax),
        description: 'Tax',
        quantity: 1,
        unitPrice: Number(order.tax),
        itemRef: QBO_MISC_ITEM_REF,
      }),
    )
  }

  if (order.note) {
    lines.push({
      DetailType: 'DescriptionOnly',
      Description: `Customer note: ${order.note}`,
    })
  }

  const hasSalesLine = lines.some((line) => line.DetailType === 'SalesItemLineDetail')

  if (!hasSalesLine) {
    lines.push(
      buildQboSalesItemLine({
        amount: Number(order.totalPrice || 0),
        description: `Shopify Order ${order.orderName || order.orderId}`,
        quantity: 1,
        unitPrice: Number(order.totalPrice || 0),
        itemRef: QBO_MISC_ITEM_REF,
      }),
    )
  }

  return lines
}

async function qboCreateInvoice(shop, { order, customerId }) {
  const payload = {
    CustomerRef: { value: customerId },
    TxnDate: new Date(order.paidAt || nowIso()).toISOString().slice(0, 10),
    PrivateNote: `source=Shopify; order=${order.orderName || order.orderId}${order.note ? `; note=${order.note}` : ''}`,
    CustomerMemo: { value: `Shopify Order ${order.orderName || order.orderId}` },
    Line: await mapShopifyOrderToQboInvoiceLines(shop, order),
  }

  const response = await qboRequest({
    shop,
    method: 'POST',
    path: `/v3/company/${shop.qbo_realm_id}/invoice?minorversion=${QBO_MINOR_VERSION}`,
    body: payload,
  })

  return response.Invoice
}

async function fetchShopifyOrderDetails(shop, webhookPayload) {
  if (webhookPayload.orderId && webhookPayload.lineItems) {
    return {
      orderId: String(webhookPayload.orderId),
      orderName: webhookPayload.orderName || `#${webhookPayload.orderId}`,
      financialStatus: String(webhookPayload.financialStatus || 'paid').toLowerCase(),
      createdAt: webhookPayload.createdAt || webhookPayload.created_at || webhookPayload.paidAt || nowIso(),
      paidAt: webhookPayload.paidAt || nowIso(),
      customerEmail: webhookPayload.customerEmail || null,
      customerName: webhookPayload.customerName || null,
      note: webhookPayload.note || null,
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
    `https://${shop.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}.json`,
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
    createdAt: order.created_at || order.processed_at || order.updated_at || nowIso(),
    paidAt: order.processed_at || order.updated_at || nowIso(),
    customerEmail: order.email || order.customer?.email || null,
    customerName: [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || null,
    note: order.note || null,
    totalPrice: Number(order.current_total_price || order.total_price || 0),
    shipping: Number(order.total_shipping_price_set?.shop_money?.amount || 0),
    tax: Number(order.current_total_tax || order.total_tax || 0),
    lineItems: (order.line_items || []).map((item) => ({
      title: item.title,
      sku: item.sku || null,
      variantTitle: item.variant_title || null,
      productId: item.product_id ? String(item.product_id) : null,
      variantId: item.variant_id ? String(item.variant_id) : null,
      quantity: Number(item.quantity || 1),
      price: Number(item.price || 0),
    })),
  }
}

function getWebhookPayload(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body
  }

  if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0) {
    return {}
  }

  try {
    return JSON.parse(req.rawBody.toString('utf8'))
  } catch {
    return {}
  }
}

function createComplianceWebhookHandler(topic) {
  return async (req, res) => {
    const payload = getWebhookPayload(req)
    const shopDomain = String(req.get('x-shopify-shop-domain') || payload?.shop_domain || '').toLowerCase().trim()

    try {
      ensureWebhookSigUtil(req, SHOPIFY_API_SECRET, ALLOW_DEV_WEBHOOK_WITHOUT_HMAC)
      res.status(200).send('Webhook received')

      void (async () => {
        const shop = shopDomain ? await getShopByDomain(shopDomain) : null
        await writeSyncLog({
          shopId: shop?.id || null,
          shopifyOrderId: null,
          eventType: topic,
          status: 'received',
          message: `Shopify compliance webhook received: ${topic}`,
          payload,
        })
      })().catch((error) => {
        console.error(`Failed to log compliance webhook ${topic}:`, error)
      })

      return
    } catch (error) {
      void writeSyncLog({
        eventType: topic,
        status: 'failed',
        message: error.message,
        payload,
      }).catch((logError) => {
        console.error(`Failed to log rejected compliance webhook ${topic}:`, logError)
      })

      return res.status(401).json({ error: error.message })
    }
  }
}

app.get('/api/health', (req, res) => {
  const plan = getActivePlanConfig()
  res.json({
    ok: true,
    service: 'order2books-api',
    time: nowIso(),
    plan: plan.key,
    config: {
      appUrl: APP_URL,
      shopifyApiKeyConfigured: Boolean(SHOPIFY_API_KEY),
      shopifyApiSecretConfigured: Boolean(SHOPIFY_API_SECRET),
      qboClientIdConfigured: Boolean(QBO_CLIENT_ID),
      qboClientSecretConfigured: Boolean(QBO_CLIENT_SECRET),
      qboRedirectUriOverrideConfigured: Boolean(QBO_REDIRECT_URI),
      qboEnv: QBO_ENV,
      qboScopes: QBO_SCOPES,
      qboRedirectUri: buildQboCallbackUrl(req),
      databaseDriver: process.env.POSTGRES_URL ? 'postgres' : 'sqlite',
    },
  })
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
    if (shouldRedirectToCanonicalAppOrigin(req)) {
      return res.redirect(buildAppUrlFromRequest(req, `/api/auth/shopify/install?${new URLSearchParams(req.query).toString()}`))
    }

    const shopFromQuery = String(req.query.shop || '').trim().toLowerCase()
    const shopFromSession = String(req.shopDomainFromSession || '').trim().toLowerCase()
    const shopFromHost = extractShopDomainFromHostParam(req.query.host)
    const shop =
      (validateShopDomain(shopFromQuery) ? shopFromQuery : '') ||
      (validateShopDomain(shopFromSession) ? shopFromSession : '') ||
      (validateShopDomain(shopFromHost) ? shopFromHost : '')
    const next = String(req.query.next || '').trim().toLowerCase()

    if (!validateShopDomain(shop)) {
      return res.status(400).json({ error: 'Invalid shop domain. Expected *.myshopify.com' })
    }

    if (!SHOPIFY_API_KEY) {
      return res.status(500).json({ error: 'SHOPIFY_API_KEY is not configured' })
    }

    const state = createSignedState({
      type: 'shopify',
      shop,
      next,
      ts: Date.now(),
    })

    const redirectUri = buildShopifyCallbackUrl(req)
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

    let tokenResponse = null
    try {
      tokenResponse = await exchangeShopifyCodeForToken({ shop, code })
    } catch (error) {
      const errorText = String(error?.message || error || '').toLowerCase()
      const isCodeAlreadyUsed =
        errorText.includes('authorization code was not found or was already used') ||
        errorText.includes('oauth error invalid_request')

      if (!isCodeAlreadyUsed) {
        throw error
      }

      const existingShop = await getShopByDomain(shop)
      if (!existingShop?.shopify_access_token || !existingShop?.is_installed) {
        throw error
      }

      const isQboConnected = Boolean(
        (existingShop?.qbo_refresh_token || existingShop?.qbo_access_token) && existingShop?.qbo_realm_id,
      )

      if (!isQboConnected) {
        setActiveShopCookie(res, shop)
        return res.redirect(buildAppUrlFromRequest(req, `/api/auth/qbo/start?shop=${encodeURIComponent(shop)}`))
      }

      const embeddedAppUrl = buildEmbeddedShopifyAppUrl(shop, {
        shopify_connected: '1',
        shop,
      })
      if (embeddedAppUrl) {
        setActiveShopCookie(res, shop)
        return res.redirect(embeddedAppUrl)
      }

      setActiveShopCookie(res, shop)
      return res.redirect(buildAppUrlFromRequest(req, `/?shopify_connected=1&shop=${encodeURIComponent(shop)}`))
    }

    try {
      await registerComplianceWebhooks({
        shopDomain: shop,
        accessToken: tokenResponse.access_token,
      })
    } catch (error) {
      console.warn('Compliance webhook registration failed (continuing OAuth):', error?.message || error)
    }

    const savedShop = await upsertShopFromShopifyOAuth({
      shopDomain: shop,
      accessToken: tokenResponse.access_token,
      scope: tokenResponse.scope,
    })
    await persistPrimaryShopifyDomain(savedShop.shop_domain)

    await writeSyncLog({
      shopId: savedShop.id,
      eventType: 'shopify/oauth',
      status: 'success',
      message: 'Shopify OAuth connected and shop saved',
      payload: { shop, scope: tokenResponse.scope },
    })

    const isQboConnected = Boolean(
      (savedShop?.qbo_refresh_token || savedShop?.qbo_access_token) && savedShop?.qbo_realm_id,
    )

    if (!isQboConnected) {
      setActiveShopCookie(res, shop)
      return res.redirect(buildAppUrlFromRequest(req, `/api/auth/qbo/start?shop=${encodeURIComponent(shop)}`))
    }

    const embeddedAppUrl = buildEmbeddedShopifyAppUrl(shop, {
      shopify_connected: '1',
      shop,
    })
    if (embeddedAppUrl) {
      setActiveShopCookie(res, shop)
      return res.redirect(embeddedAppUrl)
    }

    setActiveShopCookie(res, shop)
    return res.redirect(buildAppUrlFromRequest(req, `/?shopify_connected=1&shop=${encodeURIComponent(shop)}`))
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
    console.log('[QBO START] Received request, checking shop...')
    
    if (shouldRedirectToCanonicalAppOrigin(req)) {
      console.log('[QBO START] Redirecting to canonical app origin')
      return res.redirect(buildAppUrlFromRequest(req, `/api/auth/qbo/start?${new URLSearchParams(req.query).toString()}`))
    }

    const requestedShopDomain = String(req.query.shop || req.shopDomainFromSession || '').toLowerCase().trim()
    let shopDomain = validateShopDomain(requestedShopDomain) ? requestedShopDomain : ''

    if (!shopDomain) {
      const activeShop = await getActiveInstalledShop(req)
      shopDomain = String(activeShop?.shop_domain || '').toLowerCase().trim()
    }

    if (!validateShopDomain(shopDomain)) {
      console.log('[QBO START] Invalid shop domain:', shopDomain)
      return res.status(400).json({ error: 'Missing or invalid shop domain. Expected *.myshopify.com' })
    }

    const shop = await getShopByDomain(shopDomain)

    if (!shop) {
      console.log('[QBO START] Shop not found, redirecting to install:', shopDomain)
      return res.redirect(buildAppUrlFromRequest(req, `/api/auth/shopify/install?shop=${encodeURIComponent(shopDomain)}&next=qbo`))
    }

    if (!QBO_CLIENT_ID) {
      console.log('[QBO START] QBO_CLIENT_ID not configured')
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
      `&redirect_uri=${encodeURIComponent(buildQboCallbackUrl(req))}` +
      `&state=${encodeURIComponent(state)}`

    console.log('[QBO START] Redirecting to Intuit:', authorizeUrl.substring(0, 100) + '...')
    return res.redirect(authorizeUrl)
  } catch (error) {
    console.error('[QBO START] Error:', error.message)
    return res.status(500).json({ error: error.message })
  }
})

app.get('/api/auth/qbo/callback', async (req, res) => {
  try {
    const { state, code, error, error_description } = req.query
    
    // Check for OAuth error from Intuit
    if (error) {
      await writeSyncLog({
        eventType: 'qbo/oauth',
        status: 'failed',
        message: `Intuit OAuth error: ${error}`,
        payload: { error, error_description },
      })
      const fallbackUrl = buildAppUrlFromRequest(req, `/?qbo_error=intuit_oauth_failed&error=${encodeURIComponent(error)}`)
      return res.redirect(fallbackUrl)
    }
    
    // Validate authorization code
    if (!code) {
      await writeSyncLog({
        eventType: 'qbo/oauth',
        status: 'failed',
        message: 'Missing authorization code in callback',
        payload: req.query,
      })
      const fallbackUrl = buildAppUrlFromRequest(req, `/?qbo_error=missing_auth_code`)
      return res.redirect(fallbackUrl)
    }
    
    const rawState = String(state || '').trim()

    let statePayload = null
    try {
      statePayload = verifySignedState(rawState)
    } catch {
      if (validateShopDomain(rawState)) {
        statePayload = {
          type: 'qbo',
          shop: rawState,
        }
      } else {
        throw new Error('Invalid QuickBooks state payload')
      }
    }

    if (statePayload.type !== 'qbo') {
      return res.status(400).json({ error: 'Invalid QuickBooks state payload' })
    }

    const db = await getDb()
    const stateShopDomain = String(statePayload.shop || rawState || '').toLowerCase().trim()

    let shop = null
    if (validateShopDomain(stateShopDomain)) {
      shop = await getShopByDomain(stateShopDomain)
    }

    if (!shop && statePayload.shopId) {
      shop = await db.get(`SELECT * FROM shops WHERE id = ?`, [statePayload.shopId])
    }

    if (!shop) {
      const fallbackShopDomain = String(statePayload.shop || '').toLowerCase().trim()
      if (validateShopDomain(fallbackShopDomain)) {
        shop = await ensureShopRecordByDomain(fallbackShopDomain)
      }
    }

    if (!shop) {
      const activeShop = await getActiveInstalledShop(req)
      if (activeShop) {
        shop = activeShop
      }
    }

    if (!shop) {
      return res.status(404).json({ error: 'Shop not found. Complete Shopify OAuth first.' })
    }

    const realmId = String(
      req.query.realmId || req.query.realmid || req.query.realmID || req.query.realm_id || '',
    ).trim()

    if (!realmId) {
      await writeSyncLog({
        shopId: shop.id,
        eventType: 'qbo/oauth',
        status: 'failed',
        message: 'QuickBooks callback missing realmId',
        payload: req.query,
      })
      const embeddedAppUrl = buildEmbeddedShopifyAppUrl(shop.shop_domain, {
        qbo_error: 'missing_realm',
        shop: shop.shop_domain,
      })
      const fallbackUrl = buildAppUrlFromRequest(req, `/?qbo_error=missing_realm&shop=${encodeURIComponent(shop.shop_domain)}`)
      setActiveShopCookie(res, shop.shop_domain)
      return res.redirect(embeddedAppUrl || fallbackUrl)
    }

    const token = await exchangeQboCodeForToken({ code, redirectUri: buildQboCallbackUrl(req) })
    const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString()

    await updateQboTokensForShop({
      shopId: shop.id,
      realmId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt,
      syncCutoffAt: nowIso(),
    })

    await writeSyncLog({
      shopId: shop.id,
      eventType: 'qbo/oauth',
      status: 'success',
      message: 'QuickBooks connected and tokens saved',
      payload: { realmId },
    })

    const refreshedShop = await getShopById(shop.id)
    triggerMappingScan(refreshedShop, { force: true })

    const embeddedAppUrl = buildEmbeddedShopifyAppUrl(shop.shop_domain, {
      qbo_connected: 1,
      shop: shop.shop_domain,
    })
    const fallbackUrl = buildAppUrlFromRequest(req, `/?qbo_connected=1&shop=${encodeURIComponent(shop.shop_domain)}`)
    setActiveShopCookie(res, shop.shop_domain)
    return res.redirect(embeddedAppUrl || fallbackUrl)
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
  const activeShop = await getActiveInstalledShop(req)
  if (!activeShop) {
    return res.json({ syncs: [] })
  }

  const db = await getDb()
  const syncs = await db.all(
    `SELECT os.*, s.shop_domain
     FROM order_syncs os
     JOIN shops s ON s.id = os.shop_id
     WHERE os.shop_id = ?
     ORDER BY COALESCE(os.synced_at, os.updated_at, os.created_at) DESC`,
    [activeShop.id],
  )

  return res.json({
    syncs: syncs.map((row) => ({
      shopId: row.shop_id,
      shopDomain: row.shop_domain,
      shopifyOrderId: row.shopify_order_id,
      shopifyOrderName: row.shopify_order_name,
      qboCustomerId: row.qbo_customer_id,
      qboInvoiceId: row.qbo_invoice_id,
      financialStatus: row.financial_status,
      syncStatus: row.sync_status,
      lastError: row.last_error,
      syncedAt: row.synced_at,
    })),
  })
})

app.get('/api/syncs/:shopifyOrderId', async (req, res) => {
  const activeShop = await getActiveInstalledShop(req)
  if (!activeShop) {
    return res.status(404).json({ error: 'Sync not found' })
  }

  const db = await getDb()
  const sync = await db.get(
    `SELECT os.*, s.shop_domain
     FROM order_syncs os
     JOIN shops s ON s.id = os.shop_id
     WHERE os.shop_id = ? AND os.shopify_order_id = ?`,
    [activeShop.id, String(req.params.shopifyOrderId)],
  )

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

    if (!isOrderEligibleForQboSync(shop, order)) {
      return res.status(409).json({
        error: 'This order was created before QuickBooks was connected. Only brand-new Shopify orders can be synced.',
      })
    }

    // Try to sync to QB
    const customer = await qboFindOrCreateCustomer(shop, order)
    const invoice = await qboCreateInvoice(shop, {
      order,
      customerId: customer.Id,
    })

    await updateOrderSyncStatus({
      shopId: shop.id,
      shopifyOrderId: sync.shopify_order_id,
      qboCustomerId: customer.Id,
      qboInvoiceId: invoice.Id,
      financialStatus: order.financialStatus,
      syncStatus: 'synced',
      lastError: null,
    })

    await writeSyncLog({
      shopId: shop.id,
      shopifyOrderId: sync.shopify_order_id,
      eventType: 'retry',
      status: 'success',
      message: `Retry successful: Created QB invoice ${invoice.Id}`,
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
  const activeShop = await getActiveInstalledShop(req)
  if (!activeShop) {
    return res.json({ logs: [] })
  }

  const db = await getDb()
  const logs = await db.all(
    `SELECT sl.*, s.shop_domain, os.qbo_invoice_id
     FROM sync_logs sl
     LEFT JOIN shops s ON s.id = sl.shop_id
     LEFT JOIN order_syncs os ON os.shop_id = sl.shop_id AND os.shopify_order_id = sl.shopify_order_id
     WHERE sl.shop_id = ? OR sl.shop_id IS NULL
     ORDER BY sl.created_at DESC
     LIMIT 500`,
    [activeShop.id],
  )
  return res.json({ logs })
})

app.get('/api/mappings', async (req, res) => {
  const diagnosticsOnly = String(req.query?.diagnostics || '').trim() === '1'
  const activeShop = await getActiveInstalledShop(req)
  if (!activeShop) {
    return res.json({
      autoMapped: [],
      needsAttention: [],
      scanTriggered: false,
      scanInProgress: false,
      debug: {
        eligibleForScan: false,
        hasShopifyToken: false,
        hasQboRealm: false,
        hasQboToken: false,
        emptyReason: 'missing_shop_context',
        mappingCount: 0,
        lastScanStatus: '',
        lastScanMessage: '',
        lastScanAt: null,
      },
    })
  }

  const db = await getDb()
  const mappings = diagnosticsOnly
    ? []
    : await db.all(
      `SELECT *
     FROM product_mappings
     WHERE shop_id = ?
     ORDER BY datetime(updated_at) DESC
     LIMIT 500`,
      [activeShop.id],
    )

  const scanTriggered = diagnosticsOnly
    ? false
    : (mappings.length === 0 ? triggerMappingScan(activeShop) : false)
  const scanInProgress = Boolean(mappingScanInProgressByShopId.get(activeShop.id))
  const hasShopifyToken = Boolean(activeShop.shopify_access_token)
  const hasQboRealm = Boolean(activeShop.qbo_realm_id)
  const hasQboToken = Boolean(activeShop.qbo_access_token || activeShop.qbo_refresh_token)
  const eligibleForScan = Boolean(hasShopifyToken && hasQboRealm && hasQboToken)

  const lastScanLog = await db.get(
    `SELECT status, message, created_at
     FROM sync_logs
     WHERE shop_id = ? AND event_type = 'mapping/scan'
     ORDER BY created_at DESC
     LIMIT 1`,
    [activeShop.id],
  )

  let emptyReason = ''
  if (mappings.length === 0) {
    if (!hasShopifyToken) {
      emptyReason = 'missing_shopify_token'
    } else if (!hasQboRealm) {
      emptyReason = 'missing_qbo_realm'
    } else if (!hasQboToken) {
      emptyReason = 'missing_qbo_token'
    } else if (scanInProgress) {
      emptyReason = 'scan_in_progress'
    } else if (scanTriggered) {
      emptyReason = 'scan_started'
    } else {
      emptyReason = 'no_products_found'
    }
  }

  const formatted = mappings.map((mapping) => ({
    id: mapping.id,
    shopifyTitle: mapping.shopify_title,
    shopifySku: mapping.shopify_sku,
    qboItemId: mapping.qbo_item_id,
    qboItemName: mapping.qbo_item_name,
    mappingSource: mapping.mapping_source,
    status: mapping.status,
    updatedAt: mapping.updated_at,
  }))

  return res.json({
    autoMapped: formatted.filter((mapping) => mapping.status === 'mapped'),
    needsAttention: formatted.filter((mapping) => mapping.status !== 'mapped'),
    scanTriggered,
    scanInProgress,
    debug: {
      eligibleForScan,
      hasShopifyToken,
      hasQboRealm,
      hasQboToken,
      emptyReason,
      mappingCount: mappings.length,
      lastScanStatus: String(lastScanLog?.status || ''),
      lastScanMessage: String(lastScanLog?.message || ''),
      lastScanAt: lastScanLog?.created_at || null,
    },
  })
})

app.post('/api/mappings/scan', async (req, res) => {
  const activeShop = await getActiveInstalledShop(req)
  if (!activeShop) {
    return res.status(401).json({ error: 'Shopify session required.' })
  }

  if (!activeShop?.qbo_access_token || !activeShop?.qbo_realm_id) {
    return res.status(400).json({ error: 'QuickBooks must be connected before running a mapping scan.' })
  }

  const scanTriggered = triggerMappingScan(activeShop, { force: true })

  return res.status(202).json({
    success: true,
    scanTriggered,
    message: scanTriggered ? 'Mapping scan started.' : 'Mapping scan is already running.',
  })
})

app.post('/api/auth/qbo/disconnect', async (req, res) => {
  const db = await getDb()
  const requestedShopDomain = resolveShopDomainFromRequest(req)
  const activeShop = await getActiveInstalledShop(req)
  const appSettings = await db.get('SELECT * FROM app_settings WHERE id = 1')
  const fallbackShopDomain = String(appSettings?.shopify_domain || '').toLowerCase().trim()

  const resolvedShopDomain = validateShopDomain(requestedShopDomain)
    ? requestedShopDomain
    : validateShopDomain(activeShop?.shop_domain)
      ? String(activeShop.shop_domain).toLowerCase().trim()
      : validateShopDomain(fallbackShopDomain)
        ? fallbackShopDomain
        : ''

  if (!validateShopDomain(resolvedShopDomain)) {
    return res.status(400).json({ error: 'Unable to resolve shop domain for disconnect.' })
  }

  const logShop = await db.get(
    `SELECT *
     FROM shops
     WHERE shop_domain = ?
     ORDER BY datetime(updated_at) DESC
     LIMIT 1`,
    [resolvedShopDomain],
  )

  const affectedRows = await clearQboTokensForShopDomain(resolvedShopDomain)

  await writeSyncLog({
    shopId: logShop?.id || null,
    eventType: 'qbo/oauth',
    status: 'success',
    message: 'QuickBooks disconnected and tokens cleared',
    payload: {
      disconnected: true,
      shopDomain: resolvedShopDomain,
      affectedRows,
      source: validateShopDomain(requestedShopDomain)
        ? 'request'
        : validateShopDomain(activeShop?.shop_domain)
          ? 'active_shop'
          : 'app_settings',
    },
  })

  return res.json({
    success: true,
    message: 'QuickBooks disconnected.',
    shopDomain: resolvedShopDomain,
    affectedRows,
  })
})

app.post('/api/mappings/:mappingId', async (req, res) => {
  const mappingId = Number(req.params.mappingId)
  if (!mappingId) {
    return res.status(400).json({ error: 'Invalid mapping id' })
  }

  const { qboItemId, qboItemName } = req.body || {}
  if (!qboItemId || !qboItemName) {
    return res.status(400).json({ error: 'QuickBooks item id and name are required' })
  }

  const activeShop = await getActiveInstalledShop(req)
  if (!activeShop) {
    return res.status(401).json({ error: 'Shopify session required.' })
  }

  const db = await getDb()
  const existing = await db.get('SELECT * FROM product_mappings WHERE id = ? AND shop_id = ?', [mappingId, activeShop.id])

  if (!existing) {
    return res.status(404).json({ error: 'Mapping not found' })
  }

  await db.run(
    `UPDATE product_mappings
     SET qbo_item_id = ?,
         qbo_item_name = ?,
         mapping_source = 'manual',
         status = 'mapped',
         updated_at = ?
     WHERE id = ? AND shop_id = ?`,
    [String(qboItemId), String(qboItemName), nowIso(), mappingId, activeShop.id],
  )

  await writeSyncLog({
    shopId: activeShop.id,
    eventType: 'mapping/update',
    status: 'success',
    message: `Manual mapping saved for ${existing.shopify_title}`,
    payload: { mappingId, qboItemId, qboItemName },
  })

  return res.json({ success: true })
})

app.get('/api/qbo-items/search', async (req, res) => {
  const activeShop = await getActiveInstalledShop(req)
  if (!activeShop) {
    return res.status(401).json({ error: 'Shopify session required.' })
  }

  if (!activeShop.qbo_access_token) {
    return res.status(401).json({ error: 'QuickBooks not connected' })
  }

  const searchTerm = String(req.query.q || '').trim()
  if (!searchTerm) {
    return res.json({ items: [] })
  }

  try {
    const items = await qboSearchItems(activeShop, searchTerm)
    return res.json({ items })
  } catch (error) {
    console.error('QB item search error:', error)
    return res.status(500).json({ error: 'Failed to search QuickBooks items' })
  }
})

app.get('/api/settings', async (req, res) => {
  const activeShop = await getActiveInstalledShop(req)
  const db = await getDb()
  const settings = await db.get('SELECT * FROM app_settings WHERE id = 1')
  const requestedShopDomain = resolveShopDomainFromRequest(req)
  const fallbackShopDomain = validateShopDomain(requestedShopDomain)
    ? requestedShopDomain
    : String(settings?.shopify_domain || '').toLowerCase().trim()
  const resolvedShopDomain = activeShop?.shop_domain || (validateShopDomain(fallbackShopDomain) ? fallbackShopDomain : '')
  
  // Try to find shop: first with is_installed=1, then without (fallback for more resilience)
  let resolvedShop = activeShop
  if (!resolvedShop && validateShopDomain(resolvedShopDomain)) {
    resolvedShop = await db.get(
      `SELECT *
       FROM shops
       WHERE shop_domain = ? AND is_installed = 1
       ORDER BY datetime(updated_at) DESC
       LIMIT 1`,
      [resolvedShopDomain],
    )
  }
  if (!resolvedShop && validateShopDomain(resolvedShopDomain)) {
    // Fallback: treat any shop record as installed if it has shopify_access_token
    resolvedShop = await db.get(
      `SELECT *
       FROM shops
       WHERE shop_domain = ?
       ORDER BY datetime(updated_at) DESC
       LIMIT 1`,
      [resolvedShopDomain],
    )
    if (resolvedShop && !resolvedShop.shopify_access_token) {
      resolvedShop = null
    }
  }
  
  const connectionStateAuthoritative = Boolean(resolvedShop?.is_installed || (resolvedShop?.shopify_access_token && resolvedShop?.shop_domain))
  const hasStoredQboConnection = Boolean(
    (resolvedShop?.qbo_refresh_token || resolvedShop?.qbo_access_token) && resolvedShop?.qbo_realm_id,
  )
  const qboCompanyName = hasStoredQboConnection ? await getQboCompanyName(resolvedShop) : ''
  const hasQboConnection = Boolean(hasStoredQboConnection && qboCompanyName)

  return res.json({
    connection_state_authoritative: connectionStateAuthoritative,
    shop: resolvedShopDomain || null,
    shopify_connected: connectionStateAuthoritative,
    quickbooks_connected: hasQboConnection,
    settings: {
      shopifyDomain: resolvedShopDomain,
      shopifyApiKey: resolvedShop?.shopify_access_token || settings?.shopify_api_key ? '***' : '',
      shopifyConnected: connectionStateAuthoritative,
      qboConnected: hasQboConnection,
      qboCompanyName,
      autoDecrementInventory: Boolean(settings?.auto_decrement_inventory),
      autoCreateQboItems: settings?.auto_create_qbo_items !== 0,
      captureMode: normalizeCaptureMode(settings?.capture_mode),
    },
  })
})

app.get('/api/me', async (req, res) => {
  const plan = getActivePlanConfig()
  const activeShop = await getActiveInstalledShop(req)
  const db = await getDb()
  const settings = await db.get('SELECT * FROM app_settings WHERE id = 1')

  const fallbackShopDomain = String(settings?.shopify_domain || '').toLowerCase().trim()
  const normalizedFallbackShop = validateShopDomain(fallbackShopDomain) ? fallbackShopDomain : ''
  const resolvedShopDomain = activeShop?.shop_domain || normalizedFallbackShop
  const resolvedShop =
    activeShop ||
    (validateShopDomain(resolvedShopDomain) ? await getShopByDomain(resolvedShopDomain) : null)

  const quickbooksConnected = Boolean(
    (resolvedShop?.qbo_refresh_token || resolvedShop?.qbo_access_token) && resolvedShop?.qbo_realm_id,
  )

  return res.json({
    shop: resolvedShopDomain || null,
    plan: plan.key,
    integrations: {
      shopify: Boolean(resolvedShopDomain),
      quickbooks: quickbooksConnected,
    },
  })
})

// Lightweight debug endpoint to inspect stored QuickBooks tokens and optionally test a live API call.
app.get('/api/debug/qbo-status', async (req, res) => {
  try {
    const activeShop = await getActiveInstalledShop(req)
    if (!activeShop) {
      return res.status(404).json({ error: 'Active shop not found. Launch the app from a connected Shopify store.' })
    }

    const expiresAtMs = activeShop.qbo_token_expires_at ? new Date(activeShop.qbo_token_expires_at).getTime() : null
    const payload = {
      shopDomain: activeShop.shop_domain,
      hasAccessToken: Boolean(activeShop.qbo_access_token),
      hasRefreshToken: Boolean(activeShop.qbo_refresh_token),
      realmId: activeShop.qbo_realm_id || '',
      tokenExpiresAt: activeShop.qbo_token_expires_at || null,
      tokenExpiresInMs: expiresAtMs == null ? null : expiresAtMs - Date.now(),
      tokenExpired: expiresAtMs == null ? null : expiresAtMs <= Date.now(),
    }

    const shouldTestCompanyInfo =
      String(req.query.test || '').trim().toLowerCase() === 'company' && activeShop.qbo_realm_id && activeShop.qbo_access_token

    if (shouldTestCompanyInfo) {
      try {
        const response = await qboRequest({
          shop: activeShop,
          method: 'GET',
          path: `/v3/company/${activeShop.qbo_realm_id}/companyinfo/${activeShop.qbo_realm_id}?minorversion=${QBO_MINOR_VERSION}`,
        })
        payload.companyInfoTest = {
          ok: true,
          companyName: response?.CompanyInfo?.CompanyName || '',
          companyId: response?.CompanyInfo?.Id || '',
        }
      } catch (error) {
        payload.companyInfoTest = {
          ok: false,
          error: error?.message || String(error),
        }
      }
    }

    return res.json(payload)
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
})

// DEBUG: Force clear QBO tokens (useful for testing disconnect)
app.post('/api/debug/qbo-force-clear', async (req, res) => {
  try {
    const activeShop = await getActiveInstalledShop(req)
    if (!activeShop) {
      return res.status(404).json({ error: 'Active shop not found. Launch the app from a connected Shopify store.' })
    }

    const db = await getDb()
    await db.run(
      `UPDATE shops
       SET qbo_realm_id = NULL,
           qbo_access_token = NULL,
           qbo_refresh_token = NULL,
           qbo_token_expires_at = NULL,
           qbo_sync_cutoff_at = NULL,
           updated_at = ?
       WHERE id = ?`,
      [nowIso(), activeShop.id],
    )

    console.log(`[DEBUG] Force-cleared QBO tokens for shop: ${activeShop.shop_domain}`)

    return res.json({
      success: true,
      message: 'QuickBooks tokens force-cleared',
      shop: activeShop.shop_domain,
    })
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
})

app.post('/api/settings', async (req, res) => {
  const activeShop = await getActiveInstalledShop(req)
  if (!activeShop) {
    return res.status(401).json({ error: 'Shopify session required.' })
  }

  const { shopifyDomain, shopifyApiKey, autoDecrementInventory, autoCreateQboItems, captureMode } = req.body
  const normalizedCaptureMode = normalizeCaptureMode(captureMode)

  const db = await getDb()
  
  const existing = await db.get('SELECT * FROM app_settings WHERE id = 1')
  
  if (existing) {
    await db.run(
      `UPDATE app_settings 
       SET shopify_domain = ?, 
           shopify_api_key = ?,
           auto_decrement_inventory = ?,
           auto_create_qbo_items = ?,
           capture_mode = ?,
           updated_at = datetime('now')
       WHERE id = 1`,
      [
        shopifyDomain || existing.shopify_domain,
        shopifyApiKey && shopifyApiKey !== '***' ? shopifyApiKey : existing.shopify_api_key,
        autoDecrementInventory ? 1 : 0,
        autoCreateQboItems === false ? 0 : 1,
        normalizedCaptureMode,
      ],
    )
  } else {
    await db.run(
      `INSERT INTO app_settings (id, shopify_domain, shopify_api_key, auto_decrement_inventory, auto_create_qbo_items, capture_mode)
       VALUES (1, ?, ?, ?, ?, ?)`,
      [
        shopifyDomain || '',
        shopifyApiKey || '',
        autoDecrementInventory ? 1 : 0,
        autoCreateQboItems === false ? 0 : 1,
        normalizedCaptureMode,
      ],
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
    const captureMode = await getCaptureMode()

    if (!isOrderEligibleForQboSync(shop, order)) {
      await writeSyncLog({
        shopId: shop.id,
        shopifyOrderId: orderId,
        eventType: 'orders/paid',
        status: 'skipped_pre_qbo_connection',
        message: 'Order was created before QuickBooks was connected. Only brand-new orders sync to QuickBooks.',
        payload: req.body,
      })

      return res.status(202).json({
        success: true,
        skipped: true,
        message: 'Order skipped because it was created before QuickBooks was connected.',
      })
    }

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
      if (captureMode === CAPTURE_MODES.MANUAL && ['authorized', 'pending'].includes(order.financialStatus)) {
        await createOrderSyncRecord({
          shopId: shop.id,
          shopifyOrderId: orderId,
          shopifyOrderName: order.orderName,
          qboCustomerId: null,
          qboInvoiceId: null,
          financialStatus: order.financialStatus,
          syncStatus: 'pending_capture',
          lastError: 'Awaiting payment capture in Shopify before invoice sync.',
        })

        await writeSyncLog({
          shopId: shop.id,
          shopifyOrderId: orderId,
          eventType: 'orders/paid',
          status: 'pending_capture',
          message: 'Order authorized but not captured yet. Waiting for capture before QuickBooks sync.',
          payload: req.body,
        })

        return res.status(202).json({
          success: true,
          pending: true,
          message: 'Order authorized. Sync will continue after capture.',
        })
      }

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
        financialStatus: order.financialStatus,
        syncStatus: 'processing',
        lastError: null,
      })

      const customer = await qboFindOrCreateCustomer(shop, order)
      const invoice = await qboCreateInvoice(shop, {
        order,
        customerId: customer.Id,
      })

      await updateOrderSyncStatus({
        shopId: shop.id,
        shopifyOrderId: orderId,
        qboCustomerId: customer.Id,
        qboInvoiceId: invoice.Id,
        financialStatus: order.financialStatus,
        syncStatus: 'synced',
        lastError: null,
      })

      await writeSyncLog({
        shopId: shop.id,
        shopifyOrderId: orderId,
        eventType: 'orders/paid',
        status: 'success',
        message: `Created QB customer ${customer.Id}, invoice ${invoice.Id}`,
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
  try {
    ensureWebhookSigUtil(req, SHOPIFY_API_SECRET, ALLOW_DEV_WEBHOOK_WITHOUT_HMAC)

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

    return res.status(202).json({ success: true, message: 'Refund sync queued' })
  } catch (error) {
    await writeSyncLog({
      eventType: 'refunds/create',
      status: 'failed',
      message: error.message,
      payload: req.body,
    })
    return res.status(401).json({ error: error.message })
  }
})

app.post('/api/webhooks/shopify/app-uninstalled', async (req, res) => {
  try {
    ensureWebhookSigUtil(req, SHOPIFY_API_SECRET, ALLOW_DEV_WEBHOOK_WITHOUT_HMAC)

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

const customersDataRequestWebhookHandler = createComplianceWebhookHandler('customers/data_request')
const customersRedactWebhookHandler = createComplianceWebhookHandler('customers/redact')
const shopRedactWebhookHandler = createComplianceWebhookHandler('shop/redact')

app.post('/webhooks/customers/data_request', customersDataRequestWebhookHandler)
app.post('/webhooks/customers/redact', customersRedactWebhookHandler)
app.post('/webhooks/shop/redact', shopRedactWebhookHandler)

app.post('/api/webhooks/customers-data-request', customersDataRequestWebhookHandler)
app.post('/api/webhooks/customers-redact', customersRedactWebhookHandler)
app.post('/api/webhooks/shop-redact', shopRedactWebhookHandler)

app.post('/api/webhooks/shopify/customers-data-request', customersDataRequestWebhookHandler)
app.post('/api/webhooks/shopify/customers-redact', customersRedactWebhookHandler)
app.post('/api/webhooks/shopify/shop-redact', shopRedactWebhookHandler)

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
