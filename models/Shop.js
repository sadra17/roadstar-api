// ─────────────────────────────────────────────────────────────────────────────
// models/Shop.js
// One document per shop/client. Owns credentials + links to ShopSettings.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");

const shopSchema = new mongoose.Schema(
  {
    shopId:   { type: String, required: true, unique: true, trim: true },
    name:     { type: String, required: true, trim: true },
    email:    { type: String, required: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    active:   { type: Boolean, default: true },
    plan:     { type: String, enum: ["trial","active","paused"], default: "trial" },
  },
  { timestamps: true }
);

// Hash password before save
shopSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

shopSchema.methods.checkPassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

shopSchema.index({ email: 1 });

module.exports = mongoose.model("Shop", shopSchema);
