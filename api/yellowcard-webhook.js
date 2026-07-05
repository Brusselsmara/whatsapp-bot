const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');
const { verifyWebhookSignature } = require('../lib/yellowcard');

// Paste this URL into your Yellow Card dashboard's webhook settings:
//   https://<your-vercel-app>.vercel.app/api/yellowcard-webhook
//
// Confirmed against https://docs.yellowcard.engineering/docs/webhooks-api :
// - Signature arrives in the "X-YC-Signature" header
// - It's base64(sha256(rawBody)) signed with your secret key
// - Event payload shape: { id, sequenceId, status, apiKey, event, errorCode?, sessionId, executedAt }
// - Event names use prefixes RECEIVE.* (was COLLECTION.*) and SEND.* (was PAYMENT.*)
//   e.g. RECEIVE.COMPLETE, RECEIVE.FAILED, SEND.COMPLETE, SEND.FAILED

// We need the RAW body (exact bytes) to verify the signature correctly,
// so bodyParser is disabled below and we read + parse it ourselves.
module.exports.config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-yc-signature'];

  if (process.env.NODE_ENV === 'production' && !verifyWebhookSignature(rawBody, signature)) {
    console.error('Yellow Card webhook signature mismatch — rejecting.');
    return res.status(403).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).send('Invalid JSON');
  }

  try {
    // event.sequenceId is the id WE sent when submitting the receive/send
    // (we used the invoice_code for receives, and our own SEND-<timestamp> for sends).
    const status = mapStatus(event.event);
    const ycId = event.id;

    if (!ycId || !status) {
      return res.status(200).json({ received: true, note: 'Unrecognized event, ignored' });
    }

    const { data: txn } = await supabase
      .from('transactions')
      .update({ status, updated_at: new Date().toISOString(), raw_response: event })
      .eq('yellowcard_reference', ycId)
      .select()
      .single();

    if (!txn) {
      return res.status(200).json({ received: true, note: 'No matching transaction' });
    }

    if (txn.invoice_id && status === 'completed') {
      const { data: invoice } = await supabase
        .from('invoices')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', txn.invoice_id)
        .select()
        .single();

      if (invoice) {
        await sendWhatsApp(
          invoice.issuer_phone,
          `💰 You've been paid! Invoice ${invoice.invoice_code} (${invoice.amount} ${invoice.currency}) is now marked as paid.`
        );
        if (txn.from_phone) {
          await sendWhatsApp(
            txn.from_phone,
            `✅ Your payment for invoice ${invoice.invoice_code} was confirmed. Thank you!`
          );
        }
      }
    } else if (status === 'completed' && txn.type === 'payout') {
      if (txn.from_phone) {
        await sendWhatsApp(txn.from_phone, `✅ Your transfer of ${txn.amount} ${txn.currency} was completed.`);
      }
    } else if (status === 'failed') {
      const target = txn.from_phone;
      if (target) {
        await sendWhatsApp(
          target,
          `⚠️ Your payment (ref ${ycId}) failed${event.errorCode ? ` — ${event.errorCode}` : ''}. Please reply "menu" to try again.`
        );
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Error processing Yellow Card webhook:', err);
    // Still return 200 so Yellow Card doesn't hammer retries while you debug —
    // switch to 500 once you have logging/alerting in place.
    return res.status(200).json({ received: true, error: 'internal error logged' });
  }
};

function mapStatus(eventName) {
  if (!eventName) return null;
  // Handles both v2 (RECEIVE.*/SEND.*) and legacy (COLLECTION.*/PAYMENT.*) names
  if (eventName.endsWith('.COMPLETE') || eventName.endsWith('.COMPLETED')) return 'completed';
  if (eventName.endsWith('.PROCESSING')) return 'processing';
  if (eventName.endsWith('.FAILED') || eventName.endsWith('.EXPIRED')) return 'failed';
  if (eventName.endsWith('.PENDING')) return 'pending';
  return null;
}
