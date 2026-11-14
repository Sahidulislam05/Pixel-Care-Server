import type { Request, Response } from "express";
import httpStatus from "http-status";
import { AppError } from "../../utils/AppError";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import { UserServices } from "./user.service";

const uploadProfileImage = catchAsync(async (req: Request, res: Response) => {
	if (!req.file) {
		throw new AppError(httpStatus.BAD_REQUEST, "No File Provided.");
	}

	if (!req.file.mimetype.startsWith("image/")) {
		throw new AppError(httpStatus.BAD_REQUEST, "Profile image must be an image file");
	}

	const result = await UserServices.uploadProfileImage(req.file.buffer, req.user!.userId);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Profile Image Updated Successfully",
		data: result,
	});
});

const updateMyProfile = catchAsync(async (req: Request, res: Response) => {
	const result = await UserServices.updateMyProfile(req.user!, req.body);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Profile Updated Successfully",
		data: result,
	});
});

const getAllUsers = catchAsync(async (req: Request, res: Response) => {
	const { data, meta } = await UserServices.getAllUsers(req.query);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Users Retrieved Successfully",
		data,
		meta,
	});
});

const updateUserStatus = catchAsync(async (req: Request, res: Response) => {
	const result = await UserServices.updateUserStatus(
		req.user!,
		req.params.userId as string,
		req.body,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: `User ${result.status === "BLOCKED" ? "Blocked" : "Unblocked"} Successfully`,
		data: result,
	});
});

const createAdmin = catchAsync(async (req: Request, res: Response) => {
	const result = await UserServices.createAdmin(req.user!, req.body);

	sendResponse(res, {
		statusCode: httpStatus.CREATED,
		success: true,
		message: "Admin Created. Login Details Sent To Their Personal Email",
		data: result,
	});
});

export const UserController = {
	uploadProfileImage,
	updateMyProfile,
	getAllUsers,
	updateUserStatus,
	createAdmin,
};
