/**
 * Minimal auth test: hits /business/channels with NO query string, to
 * isolate whether the 401 is caused by query params being included in the
 * signed path, versus the API key/secret values themselves being wrong.
 *
 * Usage:
 *   node -r dotenv/config scripts/test-auth.js dotenv_config_path=.env.local
 */
const crypto = require('crypto');

const BASE_URL = process.env.YELLOWCARD_BASE_URL;
const API_KEY = process.env.YELLOWCARD_API_KEY;
const SECRET_KEY = process.env.YELLOWCARD_SECRET_KEY;

console.log('Loaded YELLOWCARD_BASE_URL:', BASE_URL);
console.log('Loaded YELLOWCARD_API_KEY length:', API_KEY ? API_KEY.length : 'MISSING');
console.log('Loaded YELLOWCARD_SECRET_KEY length:', SECRET_KEY ? SECRET_KEY.length : 'MISSING');
console.log('(lengths only shown, not the actual values, so check they look like the right ballpark)\n');

function buildAuthHeaders(path, method) {
  const timestamp = new Date().toISOString();
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(timestamp, 'utf8');
  hmac.update(path, 'utf8');
  hmac.update(method.toUpperCase(), 'utf8');
  const signature = hmac.digest('base64');
  return {
    'Content-Type': 'application/json',
    'X-YC-Timestamp': timestamp,
    'Authorization': `YcHmacV1 ${API_KEY}:${signature}`,
  };
}

async function main() {
  const path = '/business/channels'; // bare path, no query string, matches the docs example exactly
  const res = await fetch(`${BASE_URL}${path}`, { headers: buildAuthHeaders(path, 'GET') });
  const data = await res.json().catch(() => ({}));
  console.log('Status:', res.status);
  console.log('Response:', JSON.stringify(data, null, 2));
}

main().catch((err) => console.error('Error:', err));
