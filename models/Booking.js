const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    firstName: {
      type: String, required: [true, "First name required"],
      trim: true, maxlength: [60, "Too long"],
    },
    lastName: {
      type: String, required: [true, "Last name required"],
      trim: true, maxlength: [60, "Too long"],
    },
    phone: {
      type: String, required: [true, "Phone required"],
      trim: true, match: [/^[\d\s\-\(\)\+]{7,20}$/, "Invalid phone"],
    },
    service: {
      type: String, required: [true, "Service required"],
      enum: {
        values: ["Tire Change", "Tire Purchase", "Tire Change + Installation"],
        message: "Invalid service",
      },
    },
    customService: { type: String, trim: true, maxlength: 200, default: "" },
    date: {
      type: String, required: [true, "Date required"],
      match: [/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"],
    },
    time:     { type: String, required: [true, "Time required"] },
    duration: { type: Number, required: true, default: 10 },
    status: {
      type: String,
      enum: ["pending", "confirmed", "waitlist", "cancelled"],
      default: "pending",
    },
    notes: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { timestamps: true }
);

// Prevent double-booking same date + time
bookingSchema.index({ date: 1, time: 1 }, { unique: true });

bookingSchema.virtual("customer").get(function () {
  return `${this.firstName} ${this.lastName}`;
});
bookingSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("Booking", bookingSchema);
