// lib/phone.js — turn whatever the customer typed into E.164 for Twilio.
// "416.555.0000" / "(416) 555-0000 ext 2" → "+14165550000". North American default.
// Anything that isn't a recognisable number is passed through as before.
"use strict";

function toE164(phone) {
  const raw = String(phone || "").trim().replace(/\s*(x|ext\.?)\s*\d+$/i, "");
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  if (raw.startsWith("+") && d.length >= 8 && d.length <= 15) return "+" + d;
  return String(phone || "").trim();
}

module.exports = { toE164 };
