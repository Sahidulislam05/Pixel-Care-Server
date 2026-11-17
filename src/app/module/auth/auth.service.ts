/** biome-ignore-all lint/style/useConst: <explanation> */
import bcrypt from "bcryptjs";
import crypto from "crypto";
import ejs from "ejs";
import type { TokenPayload } from "google-auth-library";
import httpStatus from "http-status";
import type { JwtPayload, SignOptions } from "jsonwebtoken";
import path from "path";
import {
  AuthProvider,
  DoctorVerificationStatus,
  Role,
  UserStatus,
} from "../../../generated/prisma/enums";
import config from "../../config";
import { googleClient } from "../../lib/googleAuth";
import { transporter } from "../../lib/nodemailer";
import { prisma } from "../../lib/prisma";
import { redisClient } from "../../lib/redis";
import { AppError } from "../../utils/AppError";
import { jwtUtils } from "../../utils/jwt";
import type {
  IChangePasswordPayload,
  IForgotPasswordPayload,
  IGoogleLoginPayload,
  ILoginUserPayload,
  IRegisterPatientPayload,
  IRequestUser,
  IResetPasswordPayload,
  IVerifyEmailPayload,
} from "./auth.interface";

const registerPatient = async (payload: IRegisterPatientPayload) => {
  const { name, password, patient: patientData } = payload;

  const email = payload.email.trim().toLowerCase();

  const isUserExists = await prisma.user.findUnique({
    where: { email },
  });

  if (isUserExists) {
    throw new AppError(
      httpStatus.CONFLICT,
      "User with this email already exists",
    );
  }

  const hashedPassword = await bcrypt.hash(
    password,
    Number(config.bcrypt_salt_rounds),
  );

  const expirationSeconds = 5 * 60;

  const otpKey = `patient-registration-otp:${email}`;
  const otpValue = crypto.randomInt(100000, 1000000).toString();

  if (config.node_env === "development") {
    console.log(`[dev] OTP ${email} : ${otpValue}`);
  }

  await redisClient.set(otpKey, otpValue, {
    expiration: {
      type: "EX",
      value: expirationSeconds,
    },
  });

  const patientRegistrationKey = `patient-registration-data:${email}`;
  const redisUserDataPayload = {
    name,
    email,
    password: hashedPassword,
    patient: patientData,
  };

  await redisClient.set(
    patientRegistrationKey,
    JSON.stringify(redisUserDataPayload),
    {
      expiration: {
        type: "EX",
        value: expirationSeconds,
      },
    },
  );

  const tempatePath = path.join(
    process.cwd(),
    "src/app/templates/registration-user-otp.ejs",
  );

  const templateData = {
    name,
    email,
    otp: otpValue,
    expirationMinutes: expirationSeconds / 60,
  };

  const html = await ejs.renderFile(tempatePath, templateData);

  await transporter.sendMail({
    from: config.email_sender,
    to: email,
    subject: "Email Verification",
    // text : `Your OTP is ${otp}`
    // html: `<h1>Your OTP is ${otp}</h1>`
    html,
  });
};

const verifyPatientEmail = async (payload: IVerifyEmailPayload) => {
  const otp = payload.otp;
  const email = payload.email.trim().toLowerCase();

  const isUserExist = await prisma.user.findUnique({
    where: { email },
  });

  if (isUserExist?.status === "BLOCKED") {
    throw new AppError(httpStatus.FORBIDDEN, "User is Blocked");
  }

  if (isUserExist?.emailVerified) {
    throw new AppError(httpStatus.CONFLICT, "Email ALready Verified");
  }

  if (isUserExist?.isDeleted || isUserExist?.status === "DELETED") {
    throw new AppError(httpStatus.FORBIDDEN, "User is Deleted");
  }

  const otpKey = `patient-registration-otp:${email}`;

  const redisOtp = await redisClient.get(otpKey);

  if (!redisOtp) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid OTP");
  }

  if (redisOtp !== otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "OTP Does Not Match");
  }

  await redisClient.del(otpKey);

  const patientRegistrationKey = `patient-registration-data:${email}`;

  const redisPatientData = await redisClient.get(patientRegistrationKey);

  if (!redisPatientData) {
    throw new AppError(httpStatus.NOT_FOUND, "Patient Doesnt Exist");
  }

  const patientPayload: IRegisterPatientPayload = JSON.parse(redisPatientData);

  const createdUser = await prisma.user.create({
    data: {
      name: patientPayload.name,
      email: patientPayload.email,
      password: patientPayload.password,
      role: Role.PATIENT,
      status: UserStatus.ACTIVE,
      emailVerified: true,
      patient: {
        create: {
          name: patientPayload.name,
          email: patientPayload.email,
          contactNumber: patientPayload?.patient?.contactNumber || "",
        },
      },
    },
    omit: { password: true },
    include: { patient: true },
  });

  await redisClient.del(patientRegistrationKey);

  const tempatePath = path.join(
    process.cwd(),
    "src/app/templates/patient-welcome-email.ejs",
  );

  const templateData = {
    name: createdUser.name,
  };

  const html = await ejs.renderFile(tempatePath, templateData);

  await transporter.sendMail({
    from: config.email_sender,
    to: email,
    subject: "Welcome To Pixel-care System",
    // text : `Your OTP is ${otp}`
    // html: `<h1>Your OTP is ${otp}</h1>`
    html,
  });

  const { patient, ...user } = createdUser;
  const jwtPayload = {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };

  const accessToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_access_secret,
    config.jwt_access_expires_in as SignOptions,
  );

  const refreshToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_refresh_secret,
    config.jwt_refresh_expires_in as SignOptions,
  );

  return {
    user,
    patient,
    accessToken,
    refreshToken,
  };
};

const loginUser = async (payload: ILoginUserPayload) => {
  // throw new Error("Test Error");

  const { password } = payload;
  const email = payload.email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    // throw new Error("User not found");
    throw new AppError(httpStatus.NOT_FOUND, "User Not Found");
  }

  if (user.status === UserStatus.BLOCKED) {
    throw new AppError(httpStatus.FORBIDDEN, "User is blocked");
  }

  if (user.isDeleted || user.status === UserStatus.DELETED) {
    throw new AppError(httpStatus.FORBIDDEN, "User is deleted");
  }

  if (!user.emailVerified) {
    throw new AppError(httpStatus.FORBIDDEN, "Email Is Not Verified Yet");
  }

  if (user.role === Role.DOCTOR) {
    const doctor = await prisma.doctor.findUnique({
      where: { userId: user.id },
      select: { verificationStatus: true },
    });

    if (doctor?.verificationStatus !== DoctorVerificationStatus.APPROVED) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "Your Doctor Application Is Not Approved Yet",
      );
    }
  }

  if (!user.password) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      user.googleId
        ? "This Account Uses Google Login. Login With Google Or Set A Password First."
        : "Invalid credentials",
    );
  }

  const isPasswordMatched = await bcrypt.compare(password, user.password);

  if (!isPasswordMatched) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Invalid credentials");
  }

  const jwtPayload = {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };

  const accessToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_access_secret,
    config.jwt_access_expires_in as SignOptions,
  );

  const refreshToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_refresh_secret,
    config.jwt_refresh_expires_in as SignOptions,
  );

  return {
    accessToken,
    refreshToken,
  };
};

const getMe = async (user: IRequestUser) => {
  const isUserExists = await prisma.user.findUnique({
    where: {
      id: user.userId,
    },
    include: {
      patient: true,
      doctor: true,
    },
    omit: {
      password: true,
    },
  });

  if (!isUserExists) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  return isUserExists;
};

const refreshToken = async (token: string) => {
  const verifiedRefreshToken = jwtUtils.verifyToken(
    token,
    config.jwt_refresh_secret,
  );

  if (!verifiedRefreshToken.success || !verifiedRefreshToken.data) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      config.node_env === "development"
        ? verifiedRefreshToken.error
        : "Invalid refresh token",
    );
  }

  const data = verifiedRefreshToken.data as JwtPayload;

  const user = await prisma.user.findUnique({
    where: { id: data.userId },
  });

  if (!user || user.isDeleted || user.status !== UserStatus.ACTIVE) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      "User is inactive or not found",
    );
  }

  const jwtPayload = {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };

  const accessToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_access_secret,
    config.jwt_access_expires_in as SignOptions,
  );

  const refreshToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_refresh_secret,
    config.jwt_refresh_expires_in as SignOptions,
  );

  return {
    accessToken,
    refreshToken,
  };
};

const googleLogin = async (payload: IGoogleLoginPayload) => {
  let googleIdTokenPayload: TokenPayload | null | undefined = null;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: payload.idToken,
      audience: config.google_client_id,
    });

    googleIdTokenPayload = ticket.getPayload();
  } catch (error) {
    console.log("Google ID Token Verification Failed", error);
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      "Invalid Or Expired Google Id Token",
    );
  }

  if (!googleIdTokenPayload?.email || !googleIdTokenPayload.sub) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      "Invalid Or Expired Google Id Token",
    );
  }

  // An unverified Google address must never be trusted to claim an account.
  if (!googleIdTokenPayload.email_verified) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      "Your Google Email Is Not Verified",
    );
  }

  const email = googleIdTokenPayload.email.trim().toLowerCase();
  const googleId = googleIdTokenPayload.sub;
  const name = googleIdTokenPayload.name?.trim() || email.split("@")[0];

  const existingUser = await prisma.user.findUnique({ where: { email } });

  let user = existingUser;

  if (existingUser) {
    // Spec 2/3.3: Google sign-in is a patient-only feature.
    if (existingUser.role !== Role.PATIENT) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "Google Sign-In Is Only For Patients. Please Sign In With Your Email And Password.",
      );
    }

    if (existingUser.googleId && existingUser.googleId !== googleId) {
      throw new AppError(
        httpStatus.UNAUTHORIZED,
        "This Email Is Linked To A Different Google Account",
      );
    }

    // Same person, registered with email/password: link their Google account.
    if (!existingUser.googleId) {
      user = await prisma.user.update({
        where: { id: existingUser.id },
        data: { googleId, emailVerified: true },
      });
    }
  } else {
    user = await prisma.user.create({
      data: {
        name,
        email,
        role: Role.PATIENT,
        googleId,
        authProvider: AuthProvider.GOOGLE,
        emailVerified: true,
        patient: { create: { name, email } },
      },
    });

    // The account exists either way; a mail outage must not fail the sign-up.
    try {
      const html = await ejs.renderFile(
        path.join(process.cwd(), "src/app/templates/patient-welcome-email.ejs"),
        { name },
      );
      await transporter.sendMail({
        from: config.email_sender,
        to: email,
        subject: "Welcome To Pixel-care System",
        html,
      });
    } catch (error) {
      console.error("Google sign-up: welcome email failed", error);
    }
  }

  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User Not Found");
  }

  if (user.status === UserStatus.BLOCKED) {
    throw new AppError(httpStatus.FORBIDDEN, "User Is Blocked");
  }

  if (user.isDeleted || user.status === UserStatus.DELETED) {
    throw new AppError(httpStatus.FORBIDDEN, "User Is Deleted");
  }

  const jwtPayload = {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };

  const accessToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_access_secret,
    config.jwt_access_expires_in as SignOptions,
  );

  const refreshToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_refresh_secret,
    config.jwt_refresh_expires_in as SignOptions,
  );

  return {
    accessToken,
    refreshToken,
  };
};

const forgotPassword = async (payload: IForgotPasswordPayload) => {
  const email = payload.email.trim().toLowerCase();

  const isUserExist = await prisma.user.findUnique({
    where: {
      email,
    },
  });

  if (!isUserExist) {
    throw new AppError(httpStatus.NOT_FOUND, "User Does Not Exist!");
  }

  if (isUserExist.status === "BLOCKED") {
    throw new AppError(httpStatus.FORBIDDEN, "User is Blocked");
  }

  if (!isUserExist.emailVerified) {
    throw new AppError(httpStatus.FORBIDDEN, "User Not Verified");
  }

  if (isUserExist.isDeleted || isUserExist.status === "DELETED") {
    throw new AppError(httpStatus.FORBIDDEN, "User is Deleted");
  }

  if (isUserExist.googleId && isUserExist.authProvider === "GOOGLE") {
    throw new AppError(httpStatus.BAD_REQUEST, "User Has Account With Google");
  }

  const otp = crypto.randomInt(100000, 1000000).toString();

  if (config.node_env === "development")
    console.log(`[dev] Forgot-password OTP for ${email}: ${otp}`);

  const key = `forgor-password-otp:${isUserExist.email}`;

  const expirationSeconds = 5 * 60;

  await redisClient.set(key, otp, {
    expiration: {
      type: "EX",
      value: expirationSeconds,
    },
  });

  const tempatePath = path.join(
    process.cwd(),
    "src/app/templates/forgot-password.ejs",
  );

  const templateData = {
    name: isUserExist.name,
    otp,
    expirationMinutes: expirationSeconds / 60,
  };

  const html = await ejs.renderFile(tempatePath, templateData);

  await transporter.sendMail({
    from: config.email_sender,
    to: isUserExist.email,
    subject: "Forgot Password",
    // text : `Your OTP is ${otp}`
    // html: `<h1>Your OTP is ${otp}</h1>`
    html,
  });
};

const resetPassword = async (payload: IResetPasswordPayload) => {
  const { otp, newPassword } = payload;
  const email = payload.email.trim().toLowerCase();

  const isUserExist = await prisma.user.findUnique({
    where: {
      email,
    },
  });

  if (!isUserExist) {
    throw new AppError(httpStatus.NOT_FOUND, "User Does Not Exist!");
  }

  if (isUserExist.status === "BLOCKED") {
    throw new AppError(httpStatus.FORBIDDEN, "User is Blocked");
  }

  if (!isUserExist.emailVerified) {
    throw new AppError(httpStatus.FORBIDDEN, "User Not Verified");
  }

  if (isUserExist.isDeleted || isUserExist.status === "DELETED") {
    throw new AppError(httpStatus.FORBIDDEN, "User is Deleted");
  }

  if (isUserExist.googleId && isUserExist.authProvider === "GOOGLE") {
    throw new AppError(httpStatus.BAD_REQUEST, "User Has Account With Google");
  }

  const key = `forgor-password-otp:${isUserExist.email}`;

  const redisOtp = await redisClient.get(key);

  if (!redisOtp) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid OTP");
  }

  if (redisOtp !== otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "OTP Does Not Match");
  }

  const hashedNewPassword = await bcrypt.hash(
    newPassword,
    Number(config.bcrypt_salt_rounds),
  );

  await prisma.user.update({
    where: {
      email: isUserExist.email,
    },
    data: {
      password: hashedNewPassword,
    },
  });

  await redisClient.del([key]);

  const tempatePath = path.join(
    process.cwd(),
    "src/app/templates/reset-password-success.ejs",
  );

  const templateData = {
    name: isUserExist.name,
  };

  const html = await ejs.renderFile(tempatePath, templateData);

  await transporter.sendMail({
    from: config.email_sender,
    to: isUserExist.email,
    subject: "Password Changed",
    // text : `Your OTP is ${otp}`
    // html: `<h1>Your Password Is Changed</h1>`
    html,
  });
};

// Logged-in user changes their password. A Google-only patient has no password
// yet, so currentPassword is optional for them (this is the "set password" flow).
const changePassword = async (
  user: IRequestUser,
  payload: IChangePasswordPayload,
) => {
  const existingUser = await prisma.user.findUnique({
    where: { id: user.userId },
  });

  if (!existingUser) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  if (existingUser.password) {
    if (!payload.currentPassword) {
      throw new AppError(httpStatus.BAD_REQUEST, "Current Password Is Required");
    }

    const isPasswordMatched = await bcrypt.compare(
      payload.currentPassword,
      existingUser.password,
    );

    if (!isPasswordMatched) {
      throw new AppError(httpStatus.UNAUTHORIZED, "Current Password Is Incorrect");
    }
  }

  const hashedNewPassword = await bcrypt.hash(
    payload.newPassword,
    Number(config.bcrypt_salt_rounds),
  );

  await prisma.user.update({
    where: { id: existingUser.id },
    data: { password: hashedNewPassword, needPasswordChange: false },
  });
};

export const AuthService = {
  changePassword,
  registerPatient,
  verifyPatientEmail,
  loginUser,
  getMe,
  refreshToken,
  googleLogin,
  forgotPassword,
  resetPassword,
};
