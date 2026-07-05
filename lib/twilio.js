const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Send a WhatsApp message to a user.
 * @param {string} toPhone - E.164 phone number, e.g. "+26771234567" (no "whatsapp:" prefix needed here)
 * @param {string} body - message text
 */
async function sendWhatsApp(toPhone, body) {
  const to = toPhone.startsWith('whatsapp:') ? toPhone : `whatsapp:${toPhone}`;
  return client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body,
  });
}

module.exports = { sendWhatsApp };
