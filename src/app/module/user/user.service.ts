import bcrypt from "bcryptjs";
import type { UploadApiResponse } from "cloudinary";
import httpStatus from "http-status";
import { Role, UserStatus } from "../../../generated/prisma/enums";
import type { UserWhereInput } from "../../../generated/prisma/models";
import config from "../../config";
import type { IQuery } from "../../interfaces";
import { cloudinary } from "../../lib/cloudinary";
import { transporter } from "../../lib/nodemailer";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import generateRandomPassword from "../../utils/randomPassword";
import type {
	ICreateAdminPayload,
	IUpdateMyProfilePayload,
	IUpdateUserStatusPayload,
} from "./user.interface";

const ADMIN_ROLES: Role[] = [Role.ADMIN, Role.SUPER_ADMIN];

const uploadProfileImage = async (buffer: Buffer, userId: string) => {
	const currentUser = await prisma.user.findUnique({
		where: { id: userId },
		select: { imagePublicId: true },
	});

	const cloudinaryResult = await new Promise<UploadApiResponse>(
		(resolve, reject) => {
			cloudinary.uploader
				.upload_stream(
					{
						resource_type: "image",
						folder: "pixel-care/profile",
						transformation: [{ width: 512, height: 512, crop: "limit" }],
					},
					(error, result) => {
						if (error) return reject(error);
						if (!result) return reject(new Error("No result returned from Cloudinary"));
						resolve(result);
					},
				)
				.end(buffer);
		},
	);

	const updatedUser = await prisma.user.update({
		where: { id: userId },
		data: {
			imageUrl: cloudinaryResult.secure_url,
			imagePublicId: cloudinaryResult.public_id,
		},
		omit: { password: true },
	});

	if (currentUser?.imagePublicId) {
		// Old image cleanup is best-effort; the new image is already saved.
		cloudinary.uploader.destroy(currentUser.imagePublicId).catch(() => undefined);
	}

	return updatedUser;
};

// Name lives on User and is copied onto the Patient/Doctor profile; keep them in sync.
const updateMyProfile = async (user: RequestUser, payload: IUpdateMyProfilePayload) => {
	const { name, contactNumber, address } = payload;

	return prisma.$transaction(async (tx) => {
		const updatedUser = await tx.user.update({
			where: { id: user.userId },
			data: name ? { name } : {},
			omit: { password: true },
		});

		const profileData = {
			...(name ? { name } : {}),
			...(contactNumber !== undefined ? { contactNumber } : {}),
			...(address !== undefined ? { address } : {}),
		};

		if (user.role === Role.PATIENT && Object.keys(profileData).length) {
			await tx.patient.update({ where: { userId: user.userId }, data: profileData });
		}

		if (user.role === Role.DOCTOR && Object.keys(profileData).length) {
			await tx.doctor.update({ where: { userId: user.userId }, data: profileData });
		}

		return tx.user.findUnique({
			where: { id: updatedUser.id },
			omit: { password: true },
			include: { patient: true, doctor: true },
		});
	});
};

const USER_SORT_FIELDS = ["createdAt", "name", "email", "role", "status"];

const getAllUsers = async (query: IQuery) => {
	const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);
	const page = Math.max(Number(query.page) || 1, 1);
	const skip = (page - 1) * limit;
	const sortBy = USER_SORT_FIELDS.includes(String(query.sortBy)) ? String(query.sortBy) : "createdAt";
	const sortOrder = query.sortOrder === "asc" ? "asc" : "desc";

	const andConditions: UserWhereInput[] = [{ isDeleted: false }];

	if (query.searchTerm) {
		andConditions.push({
			OR: [
				{ name: { contains: query.searchTerm, mode: "insensitive" } },
				{ email: { contains: query.searchTerm, mode: "insensitive" } },
			],
		});
	}

	if (query.role && Object.values(Role).includes(query.role)) {
		andConditions.push({ role: query.role as Role });
	}

	if (query.status && Object.values(UserStatus).includes(query.status)) {
		andConditions.push({ status: query.status as UserStatus });
	}

	const where: UserWhereInput = { AND: andConditions };

	const [users, total] = await Promise.all([
		prisma.user.findMany({
			where,
			take: limit,
			skip,
			orderBy: { [sortBy]: sortOrder },
			omit: { password: true },
		}),
		prisma.user.count({ where }),
	]);

	return {
		data: users,
		meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
	};
};

// Spec 2.1: Admin may block/unblock doctors and patients; only a Super Admin
// may act on an Admin or another Super Admin. Nobody can block themselves.
const updateUserStatus = async (
	actor: RequestUser,
	userId: string,
	payload: IUpdateUserStatusPayload,
) => {
	if (actor.userId === userId) {
		throw new AppError(httpStatus.BAD_REQUEST, "You Cannot Change Your Own Status");
	}

	const target = await prisma.user.findUnique({ where: { id: userId } });

	if (!target || target.isDeleted) {
		throw new AppError(httpStatus.NOT_FOUND, "User Not Found");
	}

	if (ADMIN_ROLES.includes(target.role) && actor.role !== Role.SUPER_ADMIN) {
		throw new AppError(
			httpStatus.FORBIDDEN,
			"Only A Super Admin Can Block Or Unblock An Admin",
		);
	}

	return prisma.user.update({
		where: { id: target.id },
		data: { status: payload.status },
		omit: { password: true },
	});
};

// Spec 4: login is the organization email; the generated password goes to the
// person's own (personal) email together with that login.
const createAdmin = async (actor: RequestUser, payload: ICreateAdminPayload) => {
	if (payload.role === Role.SUPER_ADMIN && actor.role !== Role.SUPER_ADMIN) {
		throw new AppError(httpStatus.FORBIDDEN, "Only A Super Admin Can Create A Super Admin");
	}

	const email = payload.email.trim().toLowerCase();

	const isUserExists = await prisma.user.findUnique({ where: { email } });

	if (isUserExists) {
		throw new AppError(httpStatus.CONFLICT, "User Already Exists With This Email");
	}

	const password = generateRandomPassword(12);
	const hashedPassword = await bcrypt.hash(password, Number(config.bcrypt_salt_rounds));

	const createdAdmin = await prisma.user.create({
		data: {
			name: payload.name,
			email,
			password: hashedPassword,
			role: payload.role,
			emailVerified: true,
			needPasswordChange: true,
		},
		omit: { password: true },
	});

	await transporter.sendMail({
		from: config.email_sender,
		to: payload.personalEmail,
		subject: "Your Pixel-care Admin Account",
		html: `
			<p>Hello ${payload.name},</p>
			<p>An ${payload.role === Role.SUPER_ADMIN ? "super admin" : "admin"} account has been created for you on Pixel-care.</p>
			<p><strong>Login email:</strong> ${email}<br/>
			<strong>Temporary password:</strong> ${password}</p>
			<p>Please log in and change this password right away.</p>
		`,
	});

	return createdAdmin;
};

export const UserServices = {
	uploadProfileImage,
	updateMyProfile,
	getAllUsers,
	updateUserStatus,
	createAdmin,
};
