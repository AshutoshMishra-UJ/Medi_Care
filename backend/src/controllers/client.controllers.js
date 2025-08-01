import Client from "../models/client.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { uploadToCloud } from "../utils/cloudinary.js";
import { sendOtp } from "../utils/sendotp.js";

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// ✅ Nodemailer setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ✅ Robust token generator with logs & checks
const generateAccessRefreshTokens = async (clientId) => {
  console.log("📌 generateAccessRefreshTokens: clientId =", clientId);

  if (!clientId) {
    throw new ApiError(400, "Client ID is required");
  }

  const client = await Client.findById(clientId);
  if (!client) {
    throw new ApiError(400, "No client found with that ID");
  }

  const accessToken = client.generateAccessToken();
  const refreshToken = client.generateRefreshToken();

  client.refreshToken = refreshToken;
  await client.save({ validateBeforeSave: false });

  return { accessToken, refreshToken };
};

// ✅ Safe registerClient with try–catch & logs
const registerClient = asyncHandler(async (req, res) => {
  const { name, email, phone, password, age, gender } = req.body;
  console.log("📌 registerClient received:", { name, email, phone, age, gender });

  if ([name, email, phone, password, age, gender].some((field) => !field?.toString().trim())) {
    throw new ApiError(400, "All fields are required");
  }

  const existingClient = await Client.findOne({ $or: [{ email }, { phone }] });
  if (existingClient) throw new ApiError(400, "Email or phone already exists");

  const avatar = req.file?.path ? (await uploadToCloud(req.file.path)).url : "";
  const otp = generateOTP();
  const otpExpires = new Date(Date.now() + 5 * 60 * 1000);
  const verificationToken = jwt.sign({ email }, process.env.EMAIL_SECRET, { expiresIn: "1d" });

  await sendOtp(phone, otp);
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: "Your OTP for Email Verification",
    html: `<p>Your OTP is: <strong>${otp}</strong></p><p>This OTP is valid for 5 minutes.</p>`,
  });

  let client;
  try {
    client = await Client.create({
      name,
      email,
      phone,
      password,
      age,
      gender,
      avatar,
      verified: false,
      verificationToken,
      otp,
      otpExpires,
    });
    console.log("✅ Created client:", client);
  } catch (err) {
    console.error("❌ Error during Client.create:", err);
    throw new ApiError(500, "Could not create client");
  }

  if (!client?._id) {
    throw new ApiError(500, "Client created but missing ID");
  }

  const { accessToken, refreshToken } = await generateAccessRefreshTokens(client._id);

  return res
    .status(201)
    .cookie("accessToken", accessToken, { httpOnly: true, secure: true })
    .cookie("refreshToken", refreshToken, { httpOnly: true, secure: true })
    .json(new ApiResponse(201, client, "Client registered successfully!"));
});

// ✅ Clean loginClient — no redundant save!
const loginClient = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const client = await Client.findOne({ email });
  if (!client) {
    throw new ApiError(404, "Requested user doesn't exist");
  }

  const valid = await client.isPasswordCorrect(password);
  if (!valid) {
    throw new ApiError(401, "Invalid user credentials");
  }
  if (!client.verified) throw new ApiError(401, "Please verify your email first");

  const { accessToken, refreshToken } = await generateAccessRefreshTokens(client._id);

  const loggedUserFromDB = await Client.findById(client._id).select("-password -refreshToken");

  return res
    .status(200)
    .cookie("accessToken", accessToken, { httpOnly: true, secure: true })
    .cookie("refreshToken", refreshToken, { httpOnly: true, secure: true })
    .json(new ApiResponse(200, { client: loggedUserFromDB, accessToken, refreshToken }, "Client logged in successfully!"));
});

// ✅ Rest unchanged (still robust)
const verifyEmail = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) throw new ApiError(400, "Email and OTP are required");

  const client = await Client.findOne({ email });
  if (!client) throw new ApiError(400, "Client not found");

  if (client.otp !== otp || client.otpExpires < new Date()) {
    throw new ApiError(400, "Invalid or expired OTP");
  }

  client.verified = true;
  client.otp = undefined;
  client.otpExpires = undefined;
  await client.save();

  res.status(200).json(new ApiResponse(200, { message: "Email verified successfully" }));
});

const logoutClient = asyncHandler(async (req, res) => {
  await Client.findByIdAndUpdate(req.client._id, { refreshToken: null });
  return res.status(200).clearCookie("accessToken").clearCookie("refreshToken").json(new ApiResponse(200, {}, "Client logged out successfully"));
});

const updateClient = asyncHandler(async (req, res) => {
  const { name, email, phone, password, age, gender } = req.body;
  const client = await Client.findById(req.client._id);
  if (!client) throw new ApiError(404, "Client not found");

  if (email !== client.email || phone !== client.phone) {
    const existingClient = await Client.findOne({ $or: [{ email }, { phone }], _id: { $ne: client._id } });
    if (existingClient) throw new ApiError(400, "Email or phone already in use");
  }

  if (password) client.password = await bcrypt.hash(password, 10);
  if (req.file?.path) client.avatar = (await uploadToCloud(req.file.path)).url;
  Object.assign(client, { name, email, phone, age, gender });

  await client.save();
  return res.status(200).json(new ApiResponse(200, client, "Client updated successfully"));
});

const refreshAccessToken = asyncHandler(async (req, res) => {
  const incomingToken = req.cookies.refreshToken || req.body.refreshToken;
  if (!incomingToken) throw new ApiError(401, "Unauthorized request");

  const decodedToken = jwt.verify(incomingToken, process.env.REFRESH_TOKEN_SECRET);
  const client = await Client.findById(decodedToken._id);
  if (!client || incomingToken !== client.refreshToken) throw new ApiError(401, "Invalid or expired refresh token");

  const { accessToken, refreshToken } = await generateAccessRefreshTokens(client._id);

  return res.status(200).cookie("accessToken", accessToken, { httpOnly: true, secure: true })
    .cookie("refreshToken", refreshToken, { httpOnly: true, secure: true })
    .json(new ApiResponse(200, { accessToken, refreshToken }, "Token refreshed"));
});

const verifyOtp = asyncHandler(async (req, res) => {
  const { clientId, otp } = req.body;
  if (!clientId || !otp) throw new ApiError(400, "Client ID and OTP are required");

  const client = await Client.findById(clientId);
  if (!client) throw new ApiError(404, "Client not found");

  if (client.otp !== otp || client.otpExpires < Date.now()) {
    throw new ApiError(400, "Invalid or expired OTP");
  }

  client.verified = true;
  client.otp = null;
  client.otpExpires = null;
  await client.save();

  const accessToken = jwt.sign({ _id: client._id }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: process.env.ACCESS_TOKEN_EXPIRY });
  const refreshToken = jwt.sign({ _id: client._id }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: process.env.REFRESH_TOKEN_EXPIRY });

  return res
    .status(200)
    .cookie("accessToken", accessToken, { httpOnly: true, secure: true })
    .cookie("refreshToken", refreshToken, { httpOnly: true, secure: true })
    .json(new ApiResponse(200, { clientId: client._id, message: "OTP verified successfully!" }));
});

const getCurrentClient = asyncHandler(async (req, res) => {
  const client = await Client.findById(req.client._id).select("-password -refreshToken -otp -otpExpires -__v");
  return res.status(200).json(new ApiResponse(200, client, "Current Client Data"));
});

const getAllClients = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, verified, gender, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

  const filter = {};
  if (verified !== undefined) filter.verified = verified === 'true';
  if (gender) filter.gender = gender;

  const sort = {};
  sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const totalClients = await Client.countDocuments(filter);
  const clients = await Client.find(filter)
    .select("-password -refreshToken -otp -otpExpires -verificationToken")
    .sort(sort)
    .skip(skip)
    .limit(parseInt(limit));

  const totalPages = Math.ceil(totalClients / parseInt(limit));

  return res.status(200).json(new ApiResponse(200, {
    clients,
    pagination: {
      currentPage: parseInt(page),
      totalPages,
      totalClients,
      hasNextPage: parseInt(page) < totalPages,
      hasPrevPage: parseInt(page) > 1,
    },
  }, "Clients retrieved successfully"));
});

const getClientById = asyncHandler(async (req, res) => {
  const { clientId } = req.params;
  if (!clientId) throw new ApiError(400, "Client ID is required");

  const client = await Client.findById(clientId).select("-password -refreshToken -otp -otpExpires -verificationToken");
  if (!client) throw new ApiError(404, "Client not found");

  return res.status(200).json(new ApiResponse(200, client, "Client retrieved successfully"));
});

export {
  registerClient,
  loginClient,
  verifyEmail,
  logoutClient,
  updateClient,
  refreshAccessToken,
  verifyOtp,
  getCurrentClient,
  getAllClients,
  getClientById,
};
