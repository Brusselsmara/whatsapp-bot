# WhatsApp Cross-Border Payments Bot

MVP: WhatsApp bot (Twilio) + Node.js (Vercel serverless) + Supabase Postgres +
Yellow Card (stablecoin-to-fiat settlement).

Covers both:
- **B2B**: create an invoice, share a code, get paid, get notified.
- **B2C**: pay an invoice, or send money directly to someone's WhatsApp number.

## ⚠️ Important: country coverage

I checked Yellow Card's current coverage page. Of your 5 target countries, only
**3 are currently supported**:

| Country      | Currency | Receive (get paid) | Send (payout) |
|--------------|----------|---------------------|----------------|
| Botswana     | BWP      | Bank + Mobile Money (MyZaka) | Bank + Mobile Money (MyZaka) |
| South Africa | ZAR      | Bank only | Bank only |
| Zambia       | ZMW      | Mobile Money only (Airtel/MTN/TNM) | Mobile Money only |
| **Namibia**  | NAD      | ❌ not yet supported | ❌ not yet supported |
| **Zimbabwe** | ZWL      | ❌ not yet supported | ❌ not yet supported |

This bot is built for Botswana, South Africa, and Zambia. Namibia and Zimbabwe
are deliberately left out of `CURRENCY_TO_COUNTRY` in `lib/conversation.js` and
`COUNTRY_CONFIG` in `lib/yellowcard.js` — add them there the day Yellow Card's
[coverage page](https://docs.yellowcard.engineering/docs/africa) lists them.
You may want to ask Yellow Card directly about their roadmap for those two
markets, or look at a secondary provider for them in the meantime.

## How it fits together

```
Customer's WhatsApp
      │
      ▼
Twilio WhatsApp API  ──►  /api/whatsapp.js   (Vercel function)
                                │
                                ▼
                        lib/conversation.js  (menu / state machine)
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
              Supabase DB            Yellow Card API
        (users, invoices,           (quotes, collections,
         transactions, sessions)      payouts)
                                            │
                                            ▼
                              /api/yellowcard-webhook.js
                              (payment confirmed/failed)
                                            │
                                            ▼
                              Twilio sends WhatsApp update
                                    back to both parties
```

## 1. Set up Supabase

1. Create a project at https://app.supabase.com
2. Open **SQL Editor** → paste the contents of `db/schema.sql` → run it.
3. Go to **Settings → API** and copy:
   - `Project URL` → this is `SUPABASE_URL`
   - `service_role` secret key → this is `SUPABASE_SERVICE_ROLE_KEY`
   (Not the `anon` key — this app needs full server-side access.)

## 2. Set up Twilio WhatsApp

1. Create a Twilio account: https://console.twilio.com
2. For testing: enable the **WhatsApp Sandbox** (Messaging → Try it out →
   Send a WhatsApp message). For production, apply for a WhatsApp Sender.
3. From the Twilio Console home page, copy:
   - `Account SID` → `TWILIO_ACCOUNT_SID`
   - `Auth Token` → `TWILIO_AUTH_TOKEN`
4. Note your WhatsApp-enabled number, e.g. `whatsapp:+14155238886` → `TWILIO_WHATSAPP_NUMBER`
5. Once deployed (step 4 below), come back and set the sandbox/sender's
   **"When a message comes in"** webhook to:
   `https://<your-vercel-app>.vercel.app/api/whatsapp`

## 3. Set up Yellow Card

1. Get sandbox API access at https://docs.yellowcard.engineering
2. From the dashboard, get your **API key** and **secret key**
   → `YELLOWCARD_API_KEY`, `YELLOWCARD_SECRET_KEY`
3. Auth is already implemented correctly in `lib/yellowcard.js` — Yellow Card
   uses an `Authorization: YcHmacV1 {apiKey}:{signature}` header plus
   `X-YC-Timestamp`, where the signature is an HMAC-SHA256 (in base64) over
   `timestamp + path + METHOD (+ base64(sha256(body)) for POST/PUT)`.
   Confirmed directly against their docs — nothing to change here.
4. In the Yellow Card dashboard, create a webhook pointing to:
   `https://<your-vercel-app>.vercel.app/api/yellowcard-webhook`
   Subscribe to `RECEIVE.COMPLETE`, `RECEIVE.FAILED`, `SEND.COMPLETE`,
   `SEND.FAILED` (or leave it unfiltered to get all events).
5. Keep `YELLOWCARD_BASE_URL=https://sandbox.api.yellowcard.io` while testing.
   Switch to the production URL Yellow Card gives you when you go live —
   production also requires you to share your server's static IP for
   whitelisting (Vercel functions don't have a fixed outbound IP by default,
   so you'll likely need a paid add-on like Vercel's "Secure Compute" or a
   NAT gateway — worth asking Yellow Card and Vercel about this specifically
   before going live).

### Sandbox test values
- Mobile money account number `1111111111` simulates a **successful** payment.
- Mobile money account number `0000000000` simulates a **failed** payment.
- Sandbox receive requests expire after 10 minutes if not accepted — this
  bot uses `forceAccept: true` so they process immediately, no separate
  accept step needed.

## 4. Deploy to Vercel

1. Push this folder to a GitHub repo.
2. Go to https://vercel.com/new and import that repo.
3. Before the first deploy, go to **Settings → Environment Variables** and
   add every variable listed in `.env.example` with your real values.
4. Deploy. Vercel will give you a URL like `https://your-app.vercel.app`.
5. Set `PUBLIC_APP_URL` env var to that exact URL, then redeploy (needed for
   Twilio signature verification).
6. Go back and paste the two webhook URLs (step 2.5 and step 3.4 above)
   using your real Vercel URL.

## 5. Test it

Message your Twilio WhatsApp sandbox number "hi" — you should get the menu.
Try creating an invoice (option 1), then from a second phone number, reply
"2" and pay it with that invoice code.

## What's intentionally simple in this MVP (next steps for later)

- **KYC collection is basic**: the bot asks for name, DOB, address, ID
  type/number, and email in plain free-text messages, with no format
  validation. Yellow Card requires these fields for `customerType: retail`
  transactions — worth adding real validation (and possibly ID document
  photo capture via WhatsApp media messages) before scaling up.
- **Network selection is automatic**: when paying via mobile money or bank,
  the bot picks the *first* active network Yellow Card returns for that
  country/channel rather than asking the user to choose their specific
  provider (e.g. "Airtel" vs "MTN" in Zambia). Fine for a single-network
  sandbox test; for production you'll want to list options and let the user
  pick — see `yc.getNetworks()` in `lib/yellowcard.js`.
- **No retry/idempotency handling** on Yellow Card calls beyond what their
  API does natively — fine for an MVP, worth hardening before real money
  moves at volume.
- **No admin dashboard** — all data lives in Supabase; use the Supabase
  table editor to view/manage invoices and transactions for now.
- **Static IP for production webhooks/whitelisting**: see the note in the
  Yellow Card setup section above — this needs solving before going live
  on Vercel.
