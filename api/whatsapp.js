const twilio = require('twilio');
const { handleIncomingMessage } = require('../lib/conversation');

// This is the URL you'll paste into Twilio's WhatsApp Sandbox / Sender config:
//   https://<your-vercel-app>.vercel.app/api/whatsapp

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // Verify the request really came from Twilio (protects against spoofed webhooks).
  const signature = req.headers['x-twilio-signature'];
  const url = `${process.env.PUBLIC_APP_URL}/api/whatsapp`;
  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!isValid && process.env.NODE_ENV === 'production') {
    return res.status(403).send('Invalid signature');
  }

  const fromPhone = (req.body.From || '').replace('whatsapp:', '');
  const text = req.body.Body || '';

  let reply;
  try {
    reply = await handleIncomingMessage(fromPhone, text);
  } catch (err) {
    console.error('Error handling message:', err);
    reply = 'Sorry, something went wrong. Please reply "menu" to start over.';
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
};

// Vercel needs the raw/parsed body for Twilio's form-encoded webhook.
module.exports.config = {
  api: {
    bodyParser: {
      // Twilio sends application/x-www-form-urlencoded; Vercel's default
      // bodyParser handles this fine, no special config needed here.
    },
  },
};
