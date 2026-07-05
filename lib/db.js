const { createClient } = require('@supabase/supabase-js');

// Server-side client using the SERVICE ROLE key -> full DB access.
// This file only ever runs on the server (Vercel functions), never in a browser.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = { supabase };
