import type { IQuery } from "../../interfaces";
import { prisma } from "../../lib/prisma";
import type { ICreateContactMessagePayload } from "./contact.validation";

const createContactMessage = (payload: ICreateContactMessagePayload) =>
	prisma.contactMessage.create({ data: payload });

const getAllContactMessages = async (query: IQuery) => {
	const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);
	const page = Math.max(Number(query.page) || 1, 1);
	const skip = (page - 1) * limit;

	const where = query.searchTerm
		? {
				OR: [
					{ name: { contains: query.searchTerm, mode: "insensitive" as const } },
					{ email: { contains: query.searchTerm, mode: "insensitive" as const } },
					{ subject: { contains: query.searchTerm, mode: "insensitive" as const } },
				],
			}
		: {};

	const [messages, total] = await Promise.all([
		prisma.contactMessage.findMany({
			where,
			take: limit,
			skip,
			orderBy: { createdAt: query.sortOrder === "asc" ? "asc" : "desc" },
		}),
		prisma.contactMessage.count({ where }),
	]);

	return {
		data: messages,
		meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
	};
};

export const ContactServices = {
	createContactMessage,
	getAllContactMessages,
};
