import type { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import { MulterError } from "multer";
import { Prisma } from "../../generated/prisma/client";
import config from "../config";
import { AppError } from "../utils/AppError";

export const globalErrorHandler = (
	err: any,
	_req: Request,
	res: Response,
	_next: NextFunction,
) => {
	const isDevelopment = config.node_env === "development";

	if (isDevelopment) {
		console.error("Error from Global Error Handler", err);
	}

	let statusCode: number = httpStatus.INTERNAL_SERVER_ERROR;
	let errorMessage = err?.message || "Internal Server Error";

	if (err instanceof AppError) {
		statusCode = err.statusCode;
		errorMessage = err.message;
	} else if (err instanceof MulterError) {
		statusCode = httpStatus.BAD_REQUEST;
		errorMessage =
			err.code === "LIMIT_FILE_SIZE" ? "File is too large (max 5 MB)" : err.message;
	} else if (typeof err?.http_code === "number" && err.http_code < 500) {
		// Cloudinary rejects bad files (corrupt PDF, wrong type) with a 4xx http_code.
		statusCode = httpStatus.BAD_REQUEST;
		errorMessage = `File upload rejected: ${err.message}`;
	} else if (err instanceof SyntaxError && "body" in err) {
		statusCode = httpStatus.BAD_REQUEST;
		errorMessage = "Malformed JSON in request body";
	} else if (err instanceof Prisma.PrismaClientValidationError) {
		statusCode = httpStatus.BAD_REQUEST;
		errorMessage = "You have provided incorrect field type or missing fields";
	} else if (err instanceof Prisma.PrismaClientKnownRequestError) {
		if (err.code === "P2002") {
			statusCode = httpStatus.CONFLICT;
			errorMessage = "Duplicate value. This record already exists";
		} else if (err.code === "P2003") {
			statusCode = httpStatus.BAD_REQUEST;
			errorMessage = "Foreign key constraint failed";
		} else if (err.code === "P2025") {
			statusCode = httpStatus.NOT_FOUND;
			errorMessage = "Requested record was not found";
		}
	} else if (err instanceof Prisma.PrismaClientInitializationError) {
		statusCode = httpStatus.SERVICE_UNAVAILABLE;
		errorMessage = "Can't reach database server";
	}

	// Client errors (4xx) carry a message the user can act on, so they are always
	// returned. Server errors (5xx) hide their internals outside development.
	const isServerError = statusCode >= 500;

	if (isServerError && !isDevelopment) {
		console.error(err);
	}

	res.status(statusCode).json({
		success: false,
		statusCode,
		message: isServerError && !isDevelopment ? "Internal Server Error" : errorMessage,
		error: isDevelopment ? err : undefined,
		stack: isDevelopment ? err?.stack : undefined,
	});
};
