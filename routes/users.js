// routes/users.js  v9-supabase
"use strict";

const express = require("express");
const { body, param } = require("express-validator");
const bcrypt  = require("bcryptjs");
const router  = express.Router();

const { Users } = require("../lib/db");
const adminAuth = require("../middleware/adminAuth");
const { requirePermission } = require("../middleware/adminAuth");
const { handleValidation } = require("../middleware/validate");
const { createAuditLog }   = require("../middleware/audit");

router.get("/users", adminAuth, requirePermission("view:users"), async (req, res) => {
  try {
    const filter = { deleted: false };
    if (!req.user._isSuperAdmin) filter.shop_id = req.shopId;
    const users = await Users.find(filter);
    res.json({ success: true, count: users.length, users });
  } catch (err) {
    console.error("GET /api/users:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/users", adminAuth, requirePermission("manage:users"),
  [
    body("name").trim().notEmpty().isLength({ max: 100 }),
    body("email").trim().isEmail().normalizeEmail(),
    body("password").isLength({ min: 8 }),
    body("role").isIn(["owner","frontdesk","mechanic"]),
    body("shopId").optional().trim(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { name, email, password, role } = req.body;
      const shopId = req.user._isSuperAdmin && req.body.shopId ? req.body.shopId : req.shopId;
      const existing = await Users.findOne({ email: email.toLowerCase(), shop_id: shopId, deleted: false });
      if (existing) return res.status(409).json({ success: false, message: "A user with this email already exists" });
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await Users.create({ shopId, name, email: email.toLowerCase(), passwordHash, role });
      await createAuditLog(req, { action:"created", entity:"user", entityId:user.id, entityLabel:`${name} (${role})`, after:{ name, email, role, shopId } });
      res.status(201).json({ success: true, user });
    } catch (err) {
      console.error("POST /api/users:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.patch("/users/:id", adminAuth, requirePermission("manage:users"),
  [param("id").isUUID(), body("name").optional().trim(), body("role").optional().isIn(["owner","frontdesk","mechanic","superadmin"]), body("active").optional().isBoolean()],
  handleValidation,
  async (req, res) => {
    try {
      const target = await Users.findById(req.params.id);
      if (!target) return res.status(404).json({ success: false, message: "User not found" });
      if (!req.user._isSuperAdmin && target.shopId !== req.shopId) return res.status(403).json({ success: false, message: "Access denied" });
      if (req.params.id === req.user.userId && req.body.role && req.body.role !== target.role) return res.status(400).json({ success: false, message: "You cannot change your own role" });
      const updates = {};
      if (req.body.name   !== undefined) updates.name   = req.body.name;
      if (req.body.role   !== undefined) updates.role   = req.body.role;
      if (req.body.active !== undefined) updates.active = req.body.active;
      const updated = await Users.update(req.params.id, updates);
      await createAuditLog(req, { action:"updated", entity:"user", entityId:req.params.id, entityLabel:`${updated.name} (${updated.role})`, before:{ name:target.name, role:target.role }, after:updates });
      res.json({ success: true, user: updated });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.delete("/users/:id", adminAuth, requirePermission("manage:users"),
  [param("id").isUUID()], handleValidation,
  async (req, res) => {
    try {
      if (req.params.id === req.user.userId) return res.status(400).json({ success: false, message: "You cannot delete your own account" });
      const target = await Users.findById(req.params.id);
      if (!target) return res.status(404).json({ success: false, message: "User not found" });
      if (!req.user._isSuperAdmin && target.shopId !== req.shopId) return res.status(403).json({ success: false, message: "Access denied" });
      await Users.update(req.params.id, { deleted: true, deleted_at: new Date().toISOString(), active: false });
      await createAuditLog(req, { action:"deleted", entity:"user", entityId:req.params.id, entityLabel:`${target.name} (${target.role})` });
      res.json({ success: true, message: "User deactivated" });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.post("/users/:id/reset-password", adminAuth, requirePermission("manage:users"),
  [param("id").isUUID(), body("newPassword").isLength({ min: 8 })], handleValidation,
  async (req, res) => {
    try {
      const target = await Users.findById(req.params.id);
      if (!target) return res.status(404).json({ success: false, message: "User not found" });
      if (!req.user._isSuperAdmin && target.shopId !== req.shopId) return res.status(403).json({ success: false, message: "Access denied" });
      const passwordHash = await bcrypt.hash(req.body.newPassword, 10);
      await Users.update(req.params.id, { password_hash: passwordHash });
      await createAuditLog(req, { action:"password_changed", entity:"user", entityId:req.params.id, entityLabel:`${target.name} (${target.role})`, meta:{ resetBy:req.user.email } });
      res.json({ success: true, message: "Password updated" });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

module.exports = router;
