const { validationResult } = require("express-validator");

// Friendly names so the booking form and dashboard can say exactly what to fix.
const FIELD_LABELS = {
  firstName: "first name", lastName: "last name", phone: "phone number", email: "email address",
  service: "service", date: "date", time: "time", tireSize: "tire size", tireQuantity: "number of tires",
  notes: "notes", customService: "service details", finalPrice: "price", quotedPrice: "price",
  paymentMethod: "payment method", paymentStatus: "payment status", status: "status",
};

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const list = errors.array().map(e => ({ field: e.path, message: e.msg }));
    const fields = [...new Set(list.map(e => FIELD_LABELS[e.field] || e.field))];
    const custom = list.find(e => e.message && e.message !== "Invalid value");
    return res.status(422).json({
      success: false,
      message: custom ? custom.message : `Please check your ${fields.join(", ")}.`,
      errors: list,
    });
  }
  next();
};

// Accepts 416-555-0000, (416) 555 0000, 416.555.0000, +1 416 555 0000, 4165550000 x12
// Rejects junk like "++++4165550177" or "((((416))))-555-0177": at most one leading "+",
// at most one "(...)" group, and no runs of separators. 10–15 digits.
const isPhone = v => {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (s.length > 40) return false;
  if (!/^[\d\s\-().+]+(\s*(x|ext\.?)\s*\d{1,6})?$/i.test(s)) return false;
  const main = s.replace(/\s*(x|ext\.?)\s*\d+$/i, "").trim();
  // [+][country sep] [(area) sep] digits (sep digits)* — sep is one "-", "." or spaces
  if (!/^\+?\s*(?:\d{1,3}(?:\s*[\-.]\s*|\s+|(?=\()))?(?:\(\d{1,4}\)\s*(?:[\-.]\s*)?)?\d+(?:(?:\s*[\-.]\s*|\s+)\d+)*$/.test(main)) return false;
  const digits = main.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
};

// For endpoints whose fields are all plain values (text, numbers, booleans): reject any
// array/object field up front. express-validator checks array elements one by one, so
// {date:["2026-11-03"]} would otherwise pass and be saved as the text '["2026-11-03"]'.
const rejectNested = (req, res, next) => {
  const b = req.body;
  if (b !== undefined && (b === null || typeof b !== "object" || Array.isArray(b))) {
    return res.status(400).json({ success: false, message: "The request body must be a JSON object." });
  }
  const bad = Object.keys(b || {}).filter(k => b[k] !== null && typeof b[k] === "object");
  if (bad.length) {
    const fields = [...new Set(bad.map(f => FIELD_LABELS[f] || f))];
    return res.status(422).json({
      success: false,
      message: `Please check your ${fields.join(", ")}.`,
      errors: bad.map(f => ({ field: f, message: "Must be a single value, not a list or object." })),
    });
  }
  next();
};

module.exports = { handleValidation, isPhone, rejectNested };
