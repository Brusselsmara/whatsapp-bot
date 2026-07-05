/**
 * Lists the channels actually active on YOUR Yellow Card sandbox account,
 * per country. Run this whenever you get a "No active channel found" error —
 * it tells you exactly which channelType (bank/momo) you can actually use
 * right now, instead of guessing.
 *
 * Usage:
 *   node -r dotenv/config scripts/list-channels.js dotenv_config_path=.env.local BW
 *   node -r dotenv/config scripts/list-channels.js dotenv_config_path=.env.local ZA
 *   node -r dotenv/config scripts/list-channels.js dotenv_config_path=.env.local ZM
 */
const crypto = require('crypto');

const BASE_URL = process.env.YELLOWCARD_BASE_URL;
const API_KEY = process.env.YELLOWCARD_API_KEY;
const SECRET_KEY = process.env.YELLOWCARD_SECRET_KEY;
const country = process.argv[2];

if (!country) {
  console.error('Usage: node scripts/list-channels.js <COUNTRY_CODE>  e.g. BW, ZA, ZM');
  process.exit(1);
}
if (!BASE_URL || !API_KEY || !SECRET_KEY) {
  console.error('Missing YELLOWCARD_BASE_URL, YELLOWCARD_API_KEY, or YELLOWCARD_SECRET_KEY in your env.');
  process.exit(1);
}

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
  const path = `/business/channels?country=${country}`;
  const res = await fetch(`${BASE_URL}${path}`, { headers: buildAuthHeaders(path, 'GET') });
  const data = await res.json().catch(() => ({}));

  console.log('Status:', res.status);
  if (!res.ok) {
    console.log('Response:', JSON.stringify(data, null, 2));
    return;
  }

  const channels = Array.isArray(data) ? data : data.channels || [];
  if (channels.length === 0) {
    console.log(`No channels returned at all for ${country}. Your sandbox account may not have this country enabled — worth asking Yellow Card support directly.`);
    return;
  }

  console.log(`\nChannels for ${country}:`);
  channels.forEach((c) => {
    console.log(`- ${c.channelType || c.type} | status: ${c.status} | currency: ${c.currency} | id: ${c.id}`);
  });

  const active = channels.filter((c) => c.status === 'active');
  console.log(`\nActive channel types you can actually use: ${active.map((c) => c.channelType || c.type).join(', ') || 'NONE'}`);
}

main().catch((err) => console.error('Error:', err));
