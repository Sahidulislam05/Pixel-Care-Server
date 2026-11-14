import httpStatus from "http-status";
import config from "../config";
import { AppError } from "../utils/AppError";
import { redisClient } from "./redis";

export const getBkashIdToken = async () => {
	try {
		const IdTokenKey = "bkash:idToken";
		const RefreshTokenKey = "bkash:refreshToken";

		let bkashIdToken = await redisClient.get(IdTokenKey);
		const bkashIdTokenTTL = await redisClient.ttl(IdTokenKey);

		const bkashRefreshToken = await redisClient.get(RefreshTokenKey);
		const bkashRefreshTokenTTL = await redisClient.ttl(RefreshTokenKey);

		// console.log({
		//     bkashIdToken,
		//     bkashIdTokenTTL,
		//     bkashRefreshToken,
		//     bkashRefreshTokenTTL
		// });

		//bkash id token remaining time is less than equal 10 minutes or bkash id is expired
		// bkash refresh token must exist
		// bkash refresh token remaining time is more than 10 minutes
		if (
			(bkashIdTokenTTL <= 600 || !bkashIdToken) &&
			bkashRefreshToken &&
			bkashRefreshTokenTTL > 600
		) {
			const refreshTokenResponse = await fetch(
				`${config.bkash_base_url}/tokenized/checkout/token/refresh`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
						username: config.bkash_username,
						password: config.bkash_password,
					},
					body: JSON.stringify({
						app_key: config.bkash_app_key,
						app_secret: config.bkash_app_secret,
						refresh_token: bkashRefreshToken,
					}),
				},
			);
			if (!refreshTokenResponse.ok) {
				throw new AppError(httpStatus.BAD_GATEWAY, "Bkash Access Token Grant Failed");
			}

			const bkashRefreshTokenResult = await refreshTokenResponse.json();

			bkashIdToken = bkashRefreshTokenResult.id_token as string;

			await redisClient.set(IdTokenKey, bkashIdToken, {
				expiration: {
					type: "EX",
					value: 60 * 60,
				},
			});

			return bkashIdToken;
		}

		if (bkashIdTokenTTL > 600) {
			return bkashIdToken;
		}

		const response = await fetch(
			`${config.bkash_base_url}/tokenized/checkout/token/grant`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					username: config.bkash_username,
					password: config.bkash_password,
				},
				body: JSON.stringify({
					app_key: config.bkash_app_key,
					app_secret: config.bkash_app_secret,
				}),
			},
		);

		if (!response.ok) {
			throw new AppError(httpStatus.BAD_GATEWAY, "Bkash Access Token Grant Failed");
		}

		const result = await response.json();

		//bkash id token set
		await redisClient.set(IdTokenKey, result.id_token, {
			expiration: {
				type: "EX",
				value: 60 * 60, // 1hour
			},
		});

		//bkash refresh token set
		await redisClient.set(RefreshTokenKey, result.refresh_token, {
			expiration: {
				type: "EX",
				value: 60 * 60 * 24 * 28, // 28 days
			},
		});

		bkashIdToken = result.id_token;

		return bkashIdToken;
	} catch (error: any) {
		if (error instanceof AppError) {
			throw error;
		}
		throw new AppError(httpStatus.BAD_GATEWAY, error.message);
	}
};

// ---------------------------------------------------------------------------
// Tokenized checkout calls. Each one checks bKash's own status code, because
// bKash answers HTTP 200 even when the operation failed.
// ---------------------------------------------------------------------------

// bKash replies are untyped JSON; callers read only the documented fields.
// biome-ignore lint/suspicious/noExplicitAny: external API payload
const bkashPost = async (endpoint: string, body: Record<string, unknown>): Promise<any> => {
	const idToken = await getBkashIdToken();

	if (!idToken) {
		throw new AppError(httpStatus.BAD_GATEWAY, "No Bkash Access Token Found!");
	}

	const response = await fetch(`${config.bkash_base_url}${endpoint}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			Authorization: idToken,
			"X-App-Key": config.bkash_app_key,
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		throw new AppError(httpStatus.BAD_GATEWAY, `Bkash request failed (${response.status})`);
	}

	return response.json();
};

export const createBkashPayment = async (params: {
	amount: string;
	invoiceNumber: string;
	payerReference: string;
}) => {
	const result = await bkashPost("/tokenized/checkout/create", {
		mode: "0011",
		payerReference: params.payerReference,
		callbackURL: `${config.bkash_callback_url}/appointment/book-appointment/payment/callback`,
		amount: params.amount,
		currency: "BDT",
		intent: "sale",
		merchantInvoiceNumber: params.invoiceNumber,
	});

	if (result.statusCode !== "0000" || !result.paymentID || !result.bkashURL) {
		throw new AppError(
			httpStatus.BAD_GATEWAY,
			result.statusMessage || "Could Not Start Bkash Payment",
		);
	}

	return result;
};

export const executeBkashPayment = async (paymentId: string) => {
	const result = await bkashPost("/tokenized/checkout/execute", {
		paymentID: paymentId,
	});

	return {
		result,
		isCompleted: result.statusCode === "0000" && result.transactionStatus === "Completed",
	};
};

export const refundBkashPayment = async (params: {
	paymentId: string;
	trxId: string;
	amount: string;
	reason: string;
}) => {
	const result = await bkashPost("/tokenized/checkout/payment/refund", {
		paymentID: params.paymentId,
		trxID: params.trxId,
		amount: params.amount,
		sku: "Appointment",
		reason: params.reason,
	});

	if (result.transactionStatus !== "Completed" || !result.refundTrxID) {
		throw new AppError(
			httpStatus.BAD_GATEWAY,
			result.errorMessage || result.statusMessage || "Bkash Refund Failed",
		);
	}

	return result;
};
