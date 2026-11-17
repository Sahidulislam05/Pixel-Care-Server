// Vercel serverless entry. Vercel runs this per request instead of src/server.ts
// (which calls app.listen and starts cron jobs — neither works on serverless).
import type { Request, Response } from "express";
import app from "../src/app";
import { redisClient } from "../src/app/lib/redis";

let redisReady: Promise<unknown> | null = null;

export default async function handler(req: Request, res: Response) {
	// Connect once per warm instance; reused across invocations.
	if (!redisClient.isOpen) {
		redisReady ??= redisClient.connect().catch((error) => {
			redisReady = null;
			throw error;
		});
		await redisReady;
	}
	return app(req, res);
}
