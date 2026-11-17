// Vercel serverless entry. Vercel runs this per request instead of src/server.ts
// (which calls app.listen and starts cron jobs — neither works on serverless).
// tsup bundles this file to dist/vercel.js, which api/index.js re-exports.
import type { Request, Response } from "express";
import app from "./app";
import { redisClient } from "./app/lib/redis";

redisClient.on("error", (error) => console.error("Redis error:", error.message));

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
