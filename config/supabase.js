// ─────────────────────────────────────────────────────────────────────────────
// config/supabase.js
//
// Single Supabase client used by the entire API.
// Uses the SERVICE_ROLE key — this bypasses Row Level Security.
// Never expose this key to the frontend or public clients.
//
// Environment variables required:
//   SUPABASE_URL      — from Supabase dashboard → Settings → API
//   SUPABASE_SERVICE_KEY — "service_role" secret key (not the anon key)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl     = process.env.SUPABASE_URL;
const supabaseKey     = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("[Supabase] SUPABASE_URL and SUPABASE_SERVICE_KEY must be set");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken:  false,
    persistSession:    false,
    detectSessionInUrl:false,
  },
});

// Test connection on startup
async function connectDB() {
  try {
    const { error } = await supabase.from("shops").select("shop_id").limit(1);
    if (error) throw error;
    console.log("[Supabase] Connected ✓");
  } catch (err) {
    console.error("[Supabase] Connection failed:", err.message);
    process.exit(1);
  }
}

module.exports = supabase;
module.exports.connectDB = connectDB;
