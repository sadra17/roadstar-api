const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  firstName:     { type: String, required: true, trim: true, maxlength: 60 },
  lastName:      { type: String, required: true, trim: true, maxlength: 60 },
  phone:         { type: String, required: true, trim: true },
  service: {
    type: String, required: true,
    enum: ["Tire Change", "Tire Purchase", "Tire Change + Installation", "Flat Tire Repair", "Wheel Balancing", "Tire Rotation", "TPMS Service", "Other"],
  },
  customService: { type: String, trim: true, maxlength: 200, default: "" },
  date:          { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  time:          { type: String, required: true },
  duration:      { type: Number, required: true, default: 10 },
  status: {
    type: String,
    enum: ["pending", "confirmed", "waitlist", "completed", "cancelled"],
    default: "pending",
  },
  notes:       { type: String, trim: true, maxlength: 500, default: "" },
  completedAt: { type: Date, default: null },
  smsSentAt:   { type: Date, default: null },
}, { timestamps: true });

bookingSchema.index({ date: 1, time: 1 }, { unique: true });

bookingSchema.virtual("customer").get(function () {
  return `${this.firstName} ${this.lastName}`;
});
bookingSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("Booking", bookingSchema);
