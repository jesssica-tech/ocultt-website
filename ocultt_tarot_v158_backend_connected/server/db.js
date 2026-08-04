// ── Supabase client (service-role, backend-only) ──────────────────────
// This key bypasses Row Level Security — it must NEVER be sent to the
// browser. Only server/ code ever imports this file. The frontend talks
// to Supabase only indirectly, through our own /api routes.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
} else {
  console.warn('[db] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — every DB-backed route will ' +
    'return 503 until these are configured. See server/.env.example and server/schema.sql.');
}

module.exports = { supabase };
