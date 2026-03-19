const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    // Customer details
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
      maxlength: [60, "First name too long"],
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      trim: true,
      maxlength: [60, "Last name too long"],
    },
    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
      match: [/^[\d\s\-\(\)\+]{7,20}$/, "Invalid phone number format"],
    },

    // Appointment details
    service: {
      type: String,
      required: [true, "Service type is required"],
      enum: {
        values: ["Tire Change", "Tire Purchase", "Tire Change + Installation"],
        message: "Invalid service type",
      },
    },
    customService: {
      type: String,
      trim: true,
      maxlength: [200, "Custom service description too long"],
      default: "",
    },
    date: {
      type: String,          // Stored as "YYYY-MM-DD" string
      required: [true, "Date is required"],
      match: [/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"],
    },
    time: {
      type: String,          // e.g. "10:00 AM"
      required: [true, "Time slot is required"],
    },
    duration: {
      type: Number,          // minutes
      required: true,
      default: 10,
    },

    // Status lifecycle
    status: {
      type: String,
      enum: ["pending", "confirmed", "waitlist", "cancelled"],
      default: "pending",
    },

    // Internal notes (admin only)
    notes: {
      type: String,
      trim: true,
      maxlength: [500, "Notes too long"],
      default: "",
    },
  },
  {
    timestamps: true,        // createdAt + updatedAt
  }
);

// Compound index to enforce uniqueness per date+time slot
bookingSchema.index({ date: 1, time: 1 }, { unique: true });

// Virtual: full customer name
bookingSchema.virtual("customer").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

bookingSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("Booking", bookingSchema);
