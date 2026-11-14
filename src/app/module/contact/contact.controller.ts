import type { Request, Response } from "express";
import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import { ContactServices } from "./contact.service";

const createContactMessage = catchAsync(async (req: Request, res: Response) => {
	const result = await ContactServices.createContactMessage(req.body);

	sendResponse(res, {
		statusCode: httpStatus.CREATED,
		success: true,
		message: "Thanks For Reaching Out. We Will Get Back To You Soon",
		data: result,
	});
});

const getAllContactMessages = catchAsync(async (req: Request, res: Response) => {
	const { data, meta } = await ContactServices.getAllContactMessages(req.query);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Contact Messages Retrieved Successfully",
		data,
		meta,
	});
});

export const ContactController = {
	createContactMessage,
	getAllContactMessages,
};
