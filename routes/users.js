// routes/users.js  v9-supabase
"use strict";

const express = require("express");
const { body, param } = require("express-validator");
const bcrypt  = require("bcryptjs");
const router  = express.Router();

const { Users } = require("../lib/db");
const adminAuth = require("../middleware/adminAuth");
const { requirePermission, forgetAccount } = require("../middleware/adminAuth");
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
    body("shopId").optional().isString().bail().trim(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { name, email, password, role } = req.body;
      // Only a superadmin may put a new user into another shop; everyone else adds to their own.
      const shopId = req.user._isSuperAdmin && req.body.shopId ? req.body.shopId : req.shopId;
      const existing = await Users.findOne({ email: email.toLowerCase() });
      if (existing) return res.status(409).json({ success: false, message: "A user with this email already exists." });
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
  [param("id").isUUID(), body("name").optional().isString().bail().trim().notEmpty().isLength({ max: 100 }), body("role").optional().isString().bail().isIn(["owner","frontdesk","mechanic","superadmin"]), body("active").optional().custom(v => typeof v === "boolean").withMessage("active must be true or false")],
  handleValidation,
  async (req, res) => {
    try {
      const target = await Users.findById(req.params.id);
      if (!target || target.deleted) return res.status(404).json({ success: false, message: "User not found" });
      if (!req.user._isSuperAdmin && target.shopId !== req.shopId) return res.status(403).json({ success: false, message: "Access denied" });
      // Only a superadmin may grant the superadmin role, change a superadmin's account,
      // or move a user to another shop.
      if (!req.user._isSuperAdmin) {
        if (req.body.role === "superadmin" && target.role !== "superadmin") return res.status(403).json({ success: false, message: "Only a super admin can grant the Super Admin role." });
        if (target.role === "superadmin") return res.status(403).json({ success: false, message: "Only a super admin can change a Super Admin account." });
        if (req.body.shopId !== undefined && req.body.shopId !== target.shopId) return res.status(403).json({ success: false, message: "Only a super admin can move a user to another shop." });
      }
      const isSelf = req.params.id === req.user.userId;
      if (isSelf && req.body.role && req.body.role !== target.role) return res.status(400).json({ success: false, message: "You cannot change your own role" });
      // Deactivating yourself would lock you out (login only accepts active accounts)
      if (isSelf && req.body.active === false) return res.status(400).json({ success: false, message: "You cannot deactivate your own account" });
      const updates = {};
      if (req.body.name   !== undefined) updates.name   = req.body.name;
      if (req.body.role   !== undefined) updates.role   = req.body.role;
      if (req.body.active !== undefined) updates.active = req.body.active;
      if (!Object.keys(updates).length) return res.json({ success: true, user: target });
      const updated = await Users.update(req.params.id, updates);
      if (!updated) return res.status(404).json({ success: false, message: "User not found" });
      forgetAccount(req.params.id);
      await createAuditLog(req, { action:"updated", entity:"user", entityId:req.params.id, entityLabel:`${updated.name} (${updated.role})`, before:{ name:target.name, role:target.role, active:target.active }, after:updates });
      res.json({ success: true, user: updated });
    } catch (err) {
      console.error("PATCH /api/users/:id:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// "Deactivate" in the dashboard: the account is switched off (active=false), not erased,
// so it stays in the list and can be re-activated from Edit. Login only accepts active users.
router.delete("/users/:id", adminAuth, requirePermission("manage:users"),
  [param("id").isUUID()], handleValidation,
  async (req, res) => {
    try {
      if (req.params.id === req.user.userId) return res.status(400).json({ success: false, message: "You cannot deactivate your own account" });
      const target = await Users.findById(req.params.id);
      if (!target || target.deleted) return res.status(404).json({ success: false, message: "User not found" });
      if (!req.user._isSuperAdmin && target.shopId !== req.shopId) return res.status(403).json({ success: false, message: "Access denied" });
      if (!req.user._isSuperAdmin && target.role === "superadmin") return res.status(403).json({ success: false, message: "Only a super admin can change a Super Admin account." });
      const updated = await Users.update(req.params.id, { active: false });
      forgetAccount(req.params.id);
      if (target.active !== false) await createAuditLog(req, { action:"deactivated", entity:"user", entityId:req.params.id, entityLabel:`${target.name} (${target.role})`, field:"active", before:true, after:false });
      res.json({ success: true, user: updated, message: "User deactivated. You can re-activate them from Edit." });
    } catch (err) {
      console.error("DELETE /api/users/:id:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.post("/users/:id/reset-password", adminAuth, requirePermission("manage:users"),
  [param("id").isUUID(), body("newPassword").isLength({ min: 8 })], handleValidation,
  async (req, res) => {
    try {
      const target = await Users.findById(req.params.id);
      if (!target || target.deleted) return res.status(404).json({ success: false, message: "User not found" });
      if (!req.user._isSuperAdmin && target.shopId !== req.shopId) return res.status(403).json({ success: false, message: "Access denied" });
      if (!req.user._isSuperAdmin && target.role === "superadmin") return res.status(403).json({ success: false, message: "Only a super admin can change a Super Admin account." });
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
