const crypto = require('crypto')

/**
 * Verify Shopify webhook HMAC signature
 * @param {Object} req - Express request object
 * @param {string} secret - Shopify API Secret
 * @returns {boolean} - true if signature is valid
 */
function verifyShopifyWebhookHmac(req, secret) {
  const header = String(req.get('x-shopify-hmac-sha256') || '').trim()
  if (!header || !secret || !Buffer.isBuffer(req.rawBody)) {
    return false
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('base64')

  const received = Buffer.from(header, 'utf8')
  const expected = Buffer.from(digest, 'utf8')

  if (received.length !== expected.length) {
    return false
  }

  try {
    return crypto.timingSafeEqual(received, expected)
  } catch {
    return false
  }
}

/**
 * Ensure webhook signature is valid, throw if not
 * @param {Object} req - Express request object
 * @param {string} secret - Shopify API Secret
 * @param {boolean} allowDevBypass - Allow invalid HMAC in dev mode
 * @throws {Error} if signature verification fails
 */
function ensureWebhookSignature(req, secret, allowDevBypass = false) {
  const webhookIsValid = verifyShopifyWebhookHmac(req, secret)
  if (!webhookIsValid && !allowDevBypass) {
    throw new Error('Invalid Shopify webhook HMAC')
  }
}

module.exports = { verifyShopifyWebhookHmac, ensureWebhookSignature }
