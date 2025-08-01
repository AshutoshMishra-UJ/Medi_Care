// import mongoose from 'mongoose';
import { mongoose } from "../config/db.js"; // ✅ same instance you connected

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const clientSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, trim: true },
  age: { type: Number, required: true },
  gender: { type: String, enum: ['Male', 'Female', 'Other'], required: true },
  password: { type: String, required: [true, "Please add a password"] },
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    match: [/^\+?[1-9]\d{1,14}$/, "Please enter a valid phone number"],
  },
  avatar: { type: String, default: '' },
  verified: { type: Boolean, default: false },
  refreshToken: { type: String, default: null },
  verificationToken: String,
  tokenVersion: { type: Number, default: 0 },
  otp: String,
  otpExpires: Date,
}, { timestamps: true });

clientSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

clientSchema.methods.isPasswordCorrect = async function (password) {
  return await bcrypt.compare(password, this.password);
};

clientSchema.methods.generateAccessToken = function () {
  return jwt.sign(
    { _id: this._id, email: this.email, userType: "Client", tokenVersion: this.tokenVersion },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRY }
  );
};

clientSchema.methods.generateRefreshToken = function () {
  return jwt.sign(
    { _id: this._id },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: process.env.REFRESH_TOKEN_EXPIRY }
  );
};

const Client = mongoose.model("Client", clientSchema);
export default Client;
