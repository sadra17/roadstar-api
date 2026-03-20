const mongoose = require("mongoose");
const connect = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error("MongoDB error:", err.message);
    process.exit(1);
  }
};
module.exports = connect;
