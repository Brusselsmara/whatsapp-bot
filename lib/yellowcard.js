const crypto = require('crypto');

const BASE_URL = process.env.YELLOWCARD_BASE_URL; // e.g. https://sandbox.api.yellowcard.io
const API_KEY = process.env.YELLOWCARD_API_KEY;
const SECRET_KEY = process.env.YELLOWCARD_SECRET_KEY;

// Confirmed against Yellow Card's docs (docs.yellowcard.engineering):
// - Auth scheme: "YcHmacV1" — https://docs.yellowcard.engineering/docs/authentication-api
// - Endpoints below use the current (v2) "/receive" and "/send" naming.
//   The old "/collections" and "/payments" paths still work but are deprecated.
// - Country coverage confirmed against https://docs.yellowcard.engineering/docs/africa
//   → of your 5 target countries, only Botswana (BW), South Africa (ZA), and
//   Zambia (ZM) are currently supported. Namibia and Zimbabwe are NOT yet
//   supported by Yellow Card as of writing this. See COUNTRY_CONFIG below.

const COUNTRY_CONFIG = {
  BW: { currency: 'BWP', channelTypes: ['bank', 'momo'] }, // Bank + MyZaka mobile money
  ZA: { currency: 'ZAR', channelTypes: ['bank'] },          // Bank transfer only
  ZM: { currency: 'ZMW', channelTypes: ['momo'] },          // Mobile money only (Airtel/MTN/TNM)
  // NA (Namibia) and ZW (Zimbabwe) intentionally omitted — not yet supported
  // by Yellow Card. Add them here the day Yellow Card's coverage page lists them.
};

/**
 * Build the two required auth headers for every request.
 * Message signed = ISO8601 timestamp + path + METHOD + (base64(sha256(body)) if POST/PUT)
 */
function buildAuthHeaders(path, method, body) {
  const timestamp = new Date().toISOString();
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(timestamp, 'utf8');
  hmac.update(path, 'utf8');
  hmac.update(method.toUpperCase(), 'utf8');

  if (body) {
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64');
    hmac.update(bodyHash, 'utf8');
  }

  const signature = hmac.digest('base64');

  return {
    'Content-Type': 'application/json',
    'X-YC-Timestamp': timestamp,
    'Authorization': `YcHmacV1 ${API_KEY}:${signature}`,
  };
}

async function ycRequest(method, path, body) {
  const headers = buildAuthHeaders(path, method, body);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Yellow Card API error (${res.status}): ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Verify an incoming webhook actually came from Yellow Card.
 * Per https://docs.yellowcard.engineering/docs/webhooks-api :
 * X-YC-Signature = base64(sha256(rawBody)) signed with your secret key.
 * @param {string} rawBody - the exact raw request body string (not re-serialized JSON)
 * @param {string} signatureHeader - value of the X-YC-Signature header
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', SECRET_KEY).update(rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false; // length mismatch etc.
  }
}

/**
 * List active payment channels for a country, so we know which channelId/
 * channelType to use. Filter to status === 'active' per Yellow Card's guidance.
 */
async function getChannels(country) {
  const data = await ycRequest('GET', `/business/channels?country=${country}`);
  return Array.isArray(data) ? data.filter((c) => c.status === 'active') : data;
}

/**
 * Submit a "receive" request — money coming IN from a customer (e.g. paying
 * an invoice). Uses channelType instead of a specific channelId, which lets
 * Yellow Card auto-pick an active channel for the country+currency.
 *
 * forceAccept:true skips the separate "accept" step, so the receive starts
 * processing immediately — simpler for a chat bot flow than a 2-step accept.
 *
 * @param {object} params
 * @param {string} params.sequenceId - your own unique id for this transaction (use invoice_code)
 * @param {number} params.localAmount - amount in local currency
 * @param {string} params.country - ISO 3166-2 country code, e.g. "BW"
 * @param {string} params.channelType - "bank" or "momo"
 * @param {object} params.recipient - KYC details of whoever is being paid out to (your business)
 * @param {object} params.source - payer's account details: { accountType, accountNumber, networkId? }
 */
async function submitReceive({ sequenceId, localAmount, country, channelType, currency, recipient, source }) {
  return ycRequest('POST', '/business/receive', {
    sequenceId,
    localAmount,
    country,
    currency,
    channelType,
    recipient,
    source,
    customerType: 'retail',
    forceAccept: true,
  });
}

/** Accept a receive request that was NOT force-accepted (2-step flow). */
async function acceptReceive(receiveId) {
  return ycRequest('POST', `/business/receive/${receiveId}/accept`);
}

/** Look up a receive request by Yellow Card's id. */
async function getReceive(receiveId) {
  return ycRequest('GET', `/business/receive/${receiveId}`);
}

/**
 * Submit a "send" request — money going OUT to a recipient (payout / direct
 * send / invoice settlement to a supplier).
 *
 * @param {object} params
 * @param {string} params.sequenceId - your own unique id (use your transaction id)
 * @param {number} params.localAmount - amount in local currency
 * @param {string} params.country
 * @param {string} params.channelType - "bank" or "momo"
 * @param {string} params.reason - e.g. "invoice_settlement", "other"
 * @param {object} params.sender - your business's KYC details (customerType institution) or the individual sender's
 * @param {object} params.destination - { accountName, accountNumber, accountType, networkId }
 */
async function submitSend({ sequenceId, localAmount, country, currency, channelType, reason, sender, destination }) {
  return ycRequest('POST', '/business/send', {
    sequenceId,
    localAmount,
    country,
    currency,
    channelType,
    reason,
    sender,
    destination,
    customerType: 'retail',
    forceAccept: true,
  });
}

async function getSend(sendId) {
  return ycRequest('GET', `/business/send/${sendId}`);
}

/**
 * List active networks (specific banks / mobile money providers) for a
 * country, optionally filtered to accountNumberType 'bank' or 'momo'.
 */
async function getNetworks(country, accountNumberType) {
  const data = await ycRequest('GET', `/business/networks?country=${country}`);
  const active = Array.isArray(data) ? data.filter((n) => n.status === 'active') : [];
  return accountNumberType ? active.filter((n) => n.accountNumberType === accountNumberType) : active;
}

module.exports = {
  COUNTRY_CONFIG,
  buildAuthHeaders,
  verifyWebhookSignature,
  getChannels,
  getNetworks,
  submitReceive,
  acceptReceive,
  getReceive,
  submitSend,
  getSend,
};
