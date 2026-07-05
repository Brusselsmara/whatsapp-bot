-- Run this in the Supabase SQL editor (Project -> SQL Editor -> New query)
-- before you deploy. This creates everything the bot needs.

create extension if not exists "uuid-ossp";

-- One row per WhatsApp phone number that has messaged the bot
create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  phone text unique not null,              -- e.g. "+267xxxxxxx"
  display_name text,
  country text,                            -- BW, ZA, NA, ZW, ZM
  account_type text default 'individual',  -- 'individual' or 'business'
  business_name text,
  created_at timestamptz default now()
);

-- Conversation state machine, one row per phone number
create table if not exists sessions (
  phone text primary key,
  state text default 'idle',       -- e.g. 'awaiting_invoice_amount'
  context jsonb default '{}',      -- scratch data while filling out a flow
  updated_at timestamptz default now()
);

-- B2B invoices created by a business, to be paid by a customer/partner
create table if not exists invoices (
  id uuid primary key default uuid_generate_v4(),
  invoice_code text unique not null,          -- short code customer types, e.g. "INV-4F2A"
  issuer_phone text not null references users(phone),
  payer_phone text,                           -- may be filled in when payer engages
  amount numeric(18,2) not null,
  currency text not null,                     -- BWP, ZAR, ZMW (currently the only currencies
                                               -- Yellow Card supports for BW/ZA/ZM — see README)
  description text,
  status text default 'pending',              -- pending | paid | expired | cancelled
  yellowcard_reference text,                  -- id returned by Yellow Card for this collection
  created_at timestamptz default now(),
  paid_at timestamptz
);

-- Every money movement: invoice payment, or direct send/payout
create table if not exists transactions (
  id uuid primary key default uuid_generate_v4(),
  type text not null,                 -- 'collection' (money in) | 'payout' (money out)
  invoice_id uuid references invoices(id),
  from_phone text,
  to_phone text,
  amount numeric(18,2) not null,
  currency text not null,
  status text default 'pending',      -- pending | processing | completed | failed
  yellowcard_reference text unique,
  raw_response jsonb,                 -- store Yellow Card's response for debugging/audit
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_transactions_yc_ref on transactions(yellowcard_reference);
create index if not exists idx_invoices_code on invoices(invoice_code);
