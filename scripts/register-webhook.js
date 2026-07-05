/**
 * Yellow Card has no dashboard toggle for webhooks — they're registered via
 * the API itself. Run this ONCE after you've deployed to Vercel and have
 * your sandbox keys, to point Yellow Card at your webhook endpoint.
 *
 * Usage:
 *   1. Create a .env.local in the project root (copy from .env.example)
 *      and fill in YELLOWCARD_API_KEY, YELLOWCARD_SECRET_KEY,
 *      YELLOWCARD_BASE_URL, and PUBLIC_APP_URL.
 *   2. From the project root, run:
 *        node -r dotenv/config scripts/register-webhook.js dotenv_config_path=.env.local
 *      (If you don't have the `dotenv` package yet: npm install dotenv --save-dev)
 */
const crypto = require('crypto');

const BASE_URL = process.env.YELLOWCARD_BASE_URL;
const API_KEY = process.env.YELLOWCARD_API_KEY;
const SECRET_KEY = process.env.YELLOWCARD_SECRET_KEY;
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL;

if (!BASE_URL || !API_KEY || !SECRET_KEY || !PUBLIC_APP_URL) {
  console.error('Missing one of YELLOWCARD_BASE_URL, YELLOWCARD_API_KEY, YELLOWCARD_SECRET_KEY, PUBLIC_APP_URL in your env.');
  process.exit(1);
}

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

async function main() {
  const path = '/business/webhooks';
  const body = {
    url: `${PUBLIC_APP_URL}/api/yellowcard-webhook`,
    // No "state" field = subscribe to ALL events, simplest for getting started.
    active: true,
  };

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: buildAuthHeaders(path, 'POST', body),
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  console.log('Status:', res.status);
  console.log('Response:', JSON.stringify(data, null, 2));

  if (!res.ok) {
    console.error('\nWebhook registration failed — check the response above for the reason.');
    process.exit(1);
  }
  console.log(`\n✅ Webhook registered, pointing at ${body.url}`);
}

main().catch((err) => {
  console.error('Error registering webhook:', err);
  process.exit(1);
});
