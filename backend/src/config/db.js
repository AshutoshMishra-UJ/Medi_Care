import mongoose from "mongoose";

const connectDB = async () => {
  try {
    const db = await mongoose.connect(`${process.env.MONGO_URI}/${process.env.DB_NAME}`);
    console.log(`\n✅ MongoDB Connected to DB host: ${db.connection.host}`);
    return db;
  } catch (err) {
    console.log("❌ MongoDB connection Error:", err);
    process.exit();
  }
};

export default connectDB;

// ✅ ✅ ✅ THIS is the missing piece:
export { mongoose };
