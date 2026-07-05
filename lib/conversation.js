const { supabase } = require('./db');
const yc = require('./yellowcard');

const MENU = `Welcome to *PayLink* 👋
Cross-border payments made simple.

Reply with a number:
1️⃣ Create an invoice (get paid)
2️⃣ Pay an invoice
3️⃣ Send money to someone
4️⃣ Check a payment status
0️⃣ Help`;

// Currently live on Yellow Card. Namibia (NAD) and Zimbabwe (ZWL) are not
// yet supported by Yellow Card as of writing — see README for details.
// Add them here the day Yellow Card adds coverage.
const CURRENCY_TO_COUNTRY = { BWP: 'BW', ZAR: 'ZA', ZMW: 'ZM' };
const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_TO_COUNTRY);

function shortCode() {
  return 'INV-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function getSession(phone) {
  const { data } = await supabase.from('sessions').select('*').eq('phone', phone).single();
  if (data) return data;
  const { data: created } = await supabase
    .from('sessions')
    .insert({ phone, state: 'idle', context: {} })
    .select()
    .single();
  return created;
}

async function setSession(phone, state, context = {}) {
  await supabase
    .from('sessions')
    .upsert({ phone, state, context, updated_at: new Date().toISOString() });
}

async function ensureUser(phone) {
  const { data } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (data) return data;
  const { data: created } = await supabase.from('users').insert({ phone }).select().single();
  return created;
}

function channelTypesFor(country) {
  return yc.COUNTRY_CONFIG[country]?.channelTypes || [];
}

async function handleIncomingMessage(phone, text) {
  await ensureUser(phone);
  const session = await getSession(phone);
  const msg = (text || '').trim();
  const lower = msg.toLowerCase();

  if (['hi', 'hello', 'menu', 'start', '0'].includes(lower)) {
    await setSession(phone, 'idle', {});
    return MENU;
  }

  switch (session.state) {
    case 'idle':
      return routeMainMenu(phone, msg);

    case 'invoice_amount':
      return handleInvoiceAmount(phone, msg, session);
    case 'invoice_currency':
      return handleInvoiceCurrency(phone, msg, session);
    case 'invoice_description':
      return handleInvoiceDescription(phone, msg, session);

    case 'pay_invoice_code':
      return handlePayInvoiceCode(phone, msg);
    case 'pay_channel_choice':
      return handlePayChannelChoice(phone, msg, session);
    case 'pay_momo_number':
      return handlePayMomoNumber(phone, msg, session);
    case 'pay_kyc_name':
      return handlePayKycName(phone, msg, session);
    case 'pay_kyc_dob':
      return handlePayKycDob(phone, msg, session);
    case 'pay_kyc_address':
      return handlePayKycAddress(phone, msg, session);
    case 'pay_kyc_id':
      return handlePayKycId(phone, msg, session);
    case 'pay_kyc_email':
      return handlePayKycEmail(phone, msg, session);

    case 'send_amount':
      return handleSendAmount(phone, msg, session);
    case 'send_currency':
      return handleSendCurrency(phone, msg, session);
    case 'send_channel_choice':
      return handleSendChannelChoice(phone, msg, session);
    case 'send_recipient_account':
      return handleSendRecipientAccount(phone, msg, session);
    case 'send_recipient_name':
      return handleSendRecipientName(phone, msg, session);

    case 'status_code':
      return handleStatusCode(phone, msg);

    default:
      await setSession(phone, 'idle', {});
      return MENU;
  }
}

async function routeMainMenu(phone, msg) {
  switch (msg) {
    case '1':
      await setSession(phone, 'invoice_amount', {});
      return 'How much are you invoicing for? Enter just the number (e.g. 1500).';
    case '2':
      await setSession(phone, 'pay_invoice_code', {});
      return 'Enter the invoice code you were given (e.g. INV-4F2A).';
    case '3':
      await setSession(phone, 'send_amount', {});
      return 'How much would you like to send? Enter just the number (e.g. 500).';
    case '4':
      await setSession(phone, 'status_code', {});
      return 'Enter the invoice code or transaction reference to check.';
    default:
      return MENU;
  }
}

// ---------- Invoice creation (B2B) ----------

async function handleInvoiceAmount(phone, msg, session) {
  const amount = parseFloat(msg);
  if (isNaN(amount) || amount <= 0) {
    return "That doesn't look like a valid amount. Please enter a number, e.g. 1500.";
  }
  await setSession(phone, 'invoice_currency', { ...session.context, amount });
  return `Currency? Reply with one of: ${SUPPORTED_CURRENCIES.join(', ')}\n(Only these are currently supported for settlement.)`;
}

async function handleInvoiceCurrency(phone, msg, session) {
  const currency = msg.toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return `Please choose one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
  }
  await setSession(phone, 'invoice_description', { ...session.context, currency });
  return 'Add a short description for this invoice (e.g. "Web design services - June").';
}

async function handleInvoiceDescription(phone, msg, session) {
  const { amount, currency } = session.context;
  const code = shortCode();

  const { error } = await supabase.from('invoices').insert({
    invoice_code: code,
    issuer_phone: phone,
    amount,
    currency,
    description: msg,
  });

  await setSession(phone, 'idle', {});

  if (error) {
    return "Something went wrong creating that invoice. Let's try again — reply 'menu'.";
  }

  return `✅ Invoice created!

Code: *${code}*
Amount: ${amount} ${currency}
Description: ${msg}

Share this code with whoever needs to pay you. They can reply "2" from this bot and enter *${code}* to pay.`;
}

// ---------- Pay invoice (B2C) ----------
// Yellow Card's /receive endpoint requires, for customerType=retail:
// name, phone, email, country, address, dob, idNumber, idType

async function handlePayInvoiceCode(phone, code) {
  const invoiceCode = code.trim().toUpperCase();
  const { data: invoice } = await supabase
    .from('invoices')
    .select('*')
    .eq('invoice_code', invoiceCode)
    .single();

  if (!invoice) {
    await setSession(phone, 'idle', {});
    return `I couldn't find an invoice with code ${invoiceCode}. Double-check it and reply "2" to try again.`;
  }
  if (invoice.status === 'paid') {
    await setSession(phone, 'idle', {});
    return `Invoice ${invoiceCode} has already been paid. Thanks!`;
  }

  const country = CURRENCY_TO_COUNTRY[invoice.currency];
  const channels = channelTypesFor(country);
  const ctx = { invoiceId: invoice.id, invoiceCode, amount: invoice.amount, currency: invoice.currency, country };

  if (channels.length > 1) {
    await setSession(phone, 'pay_channel_choice', ctx);
    return `How would you like to pay?\n1️⃣ Bank transfer\n2️⃣ Mobile money`;
  }

  ctx.channelType = channels[0];
  await setSession(phone, 'pay_kyc_name', ctx);
  return "Almost there — I need a few details for compliance (required by regulation).\n\nWhat's your full name?";
}

async function handlePayChannelChoice(phone, msg, session) {
  const choice = msg.trim();
  const channelType = choice === '1' ? 'bank' : choice === '2' ? 'momo' : null;
  if (!channelType) return 'Please reply 1 for bank transfer or 2 for mobile money.';
  await setSession(phone, 'pay_kyc_name', { ...session.context, channelType });
  return "Almost there — I need a few details for compliance (required by regulation).\n\nWhat's your full name?";
}

async function handlePayKycName(phone, msg, session) {
  await setSession(phone, 'pay_kyc_dob', { ...session.context, name: msg.trim() });
  return 'Date of birth? (mm/dd/yyyy)';
}

async function handlePayKycDob(phone, msg, session) {
  await setSession(phone, 'pay_kyc_address', { ...session.context, dob: msg.trim() });
  return 'Your home address? (street + city is fine)';
}

async function handlePayKycAddress(phone, msg, session) {
  await setSession(phone, 'pay_kyc_id', { ...session.context, address: msg.trim() });
  return 'ID type and number? (e.g. "National ID 123456" or "Passport A1234567")';
}

async function handlePayKycId(phone, msg, session) {
  const parts = msg.trim().split(' ');
  const idNumber = parts.pop();
  const idType = parts.join(' ') || 'national_id';
  await setSession(phone, 'pay_kyc_email', { ...session.context, idType, idNumber });
  return 'Last thing — your email address?';
}

async function handlePayKycEmail(phone, msg, session) {
  const ctx = { ...session.context, email: msg.trim() };
  if (ctx.channelType === 'momo') {
    await setSession(phone, 'pay_momo_number', ctx);
    return 'What mobile money number will you pay from? (Sandbox: 1111111111 simulates success, 0000000000 simulates failure.)';
  }
  return finalizeReceivePayment(phone, ctx, null);
}

async function handlePayMomoNumber(phone, msg, session) {
  return finalizeReceivePayment(phone, session.context, msg.trim());
}

async function finalizeReceivePayment(phone, ctx, momoNumber) {
  await setSession(phone, 'idle', {});

  const recipient = {
    name: ctx.name,
    country: ctx.country,
    phone,
    address: ctx.address,
    dob: ctx.dob,
    email: ctx.email,
    idNumber: ctx.idNumber,
    idType: ctx.idType,
  };

  const source = { accountType: ctx.channelType };
  if (ctx.channelType === 'momo') {
    source.accountNumber = momoNumber;
    try {
      const networks = await yc.getNetworks(ctx.country, 'momo');
      if (networks[0]) source.networkId = networks[0].id;
    } catch (e) {
      console.error('getNetworks failed:', e);
    }
  }

  try {
    const receive = await yc.submitReceive({
      sequenceId: ctx.invoiceCode,
      localAmount: ctx.amount,
      country: ctx.country,
      currency: ctx.currency,
      channelType: ctx.channelType,
      recipient,
      source,
    });

    await supabase.from('transactions').insert({
      type: 'collection',
      invoice_id: ctx.invoiceId,
      from_phone: phone,
      amount: ctx.amount,
      currency: ctx.currency,
      status: receive.status || 'pending',
      yellowcard_reference: receive.id,
      raw_response: receive,
    });

    await supabase
      .from('invoices')
      .update({ payer_phone: phone, yellowcard_reference: receive.id })
      .eq('id', ctx.invoiceId);

    if (ctx.channelType === 'bank' && receive.bankInfo) {
      return `To pay invoice ${ctx.invoiceCode} (${ctx.amount} ${ctx.currency}), transfer to:

Bank: ${receive.bankInfo.name}
Account name: ${receive.bankInfo.accountName}
Account number: ${receive.bankInfo.accountNumber}

I'll message you here as soon as the payment is confirmed.`;
    }

    return `✅ Payment initiated for invoice ${ctx.invoiceCode} (${ctx.amount} ${ctx.currency}) via mobile money. Reference: ${receive.id}

I'll message you here as soon as it's confirmed.`;
  } catch (err) {
    console.error('YellowCard submitReceive error:', err);
    return "I couldn't start the payment right now. Please try again shortly, or reply 'menu'.";
  }
}

// ---------- Send money ----------

async function handleSendAmount(phone, msg, session) {
  const amount = parseFloat(msg);
  if (isNaN(amount) || amount <= 0) {
    return "That doesn't look like a valid amount. Please enter a number, e.g. 500.";
  }
  await setSession(phone, 'send_currency', { ...session.context, amount });
  return `Currency? Reply with one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
}

async function handleSendCurrency(phone, msg, session) {
  const currency = msg.toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return `Please choose one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
  }
  const country = CURRENCY_TO_COUNTRY[currency];
  const channels = channelTypesFor(country);
  const ctx = { ...session.context, currency, country };

  if (channels.length > 1) {
    await setSession(phone, 'send_channel_choice', ctx);
    return `Send via:\n1️⃣ Bank transfer\n2️⃣ Mobile money`;
  }
  await setSession(phone, 'send_recipient_account', { ...ctx, channelType: channels[0] });
  return channels[0] === 'bank' ? "Recipient's bank account number?" : "Recipient's mobile money number?";
}

async function handleSendChannelChoice(phone, msg, session) {
  const choice = msg.trim();
  const channelType = choice === '1' ? 'bank' : choice === '2' ? 'momo' : null;
  if (!channelType) return 'Please reply 1 for bank transfer or 2 for mobile money.';
  await setSession(phone, 'send_recipient_account', { ...session.context, channelType });
  return channelType === 'bank' ? "Recipient's bank account number?" : "Recipient's mobile money number?";
}

async function handleSendRecipientAccount(phone, msg, session) {
  await setSession(phone, 'send_recipient_name', { ...session.context, accountNumber: msg.trim() });
  return "Recipient's full name (as it appears on the account)?";
}

async function handleSendRecipientName(phone, msg, session) {
  const ctx = { ...session.context, accountName: msg.trim() };
  await setSession(phone, 'idle', {});

  try {
    const networks = await yc.getNetworks(ctx.country, ctx.channelType);
    const networkId = networks[0]?.id;
    if (!networkId) {
      return `I couldn't find an active ${ctx.channelType} network for ${ctx.country} right now. Please try again shortly.`;
    }

    const sequenceId = `SEND-${Date.now()}`;
    const send = await yc.submitSend({
      sequenceId,
      localAmount: ctx.amount,
      country: ctx.country,
      currency: ctx.currency,
      channelType: ctx.channelType,
      reason: 'other',
      sender: { name: 'PayLink User', country: ctx.country, phone },
      destination: {
        accountName: ctx.accountName,
        accountNumber: ctx.accountNumber,
        accountType: ctx.channelType,
        networkId,
      },
    });

    await supabase.from('transactions').insert({
      type: 'payout',
      from_phone: phone,
      amount: ctx.amount,
      currency: ctx.currency,
      status: send.status || 'pending',
      yellowcard_reference: send.id,
      raw_response: send,
    });

    return `✅ Sending ${ctx.amount} ${ctx.currency} to ${ctx.accountName}. I'll let you know once it's confirmed. Reference: ${send.id}`;
  } catch (err) {
    console.error('YellowCard submitSend error:', err);
    return "I couldn't start that transfer right now. Please try again shortly, or reply 'menu'.";
  }
}

// ---------- Status check ----------

async function handleStatusCode(phone, msg) {
  const code = msg.trim().toUpperCase();
  await setSession(phone, 'idle', {});

  const { data: invoice } = await supabase.from('invoices').select('*').eq('invoice_code', code).single();
  if (invoice) {
    return `Invoice ${code}: ${invoice.status.toUpperCase()} — ${invoice.amount} ${invoice.currency}`;
  }

  const { data: txn } = await supabase
    .from('transactions')
    .select('*')
    .eq('yellowcard_reference', msg.trim())
    .single();
  if (txn) {
    return `Transaction ${msg.trim()}: ${txn.status.toUpperCase()} — ${txn.amount} ${txn.currency}`;
  }

  return "I couldn't find anything with that code. Double check it, or reply 'menu'.";
}

module.exports = { handleIncomingMessage, MENU };
