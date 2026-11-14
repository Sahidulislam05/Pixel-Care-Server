import z from "zod";

export const CreateContactMessageZodSchema = z.object({
	name: z.string().trim().min(2, "Name must be at least 2 characters long").max(50),
	email: z.email("Invalid email address"),
	subject: z.string().trim().min(3, "Subject must be at least 3 characters long").max(120),
	message: z
		.string()
		.trim()
		.min(10, "Message must be at least 10 characters long")
		.max(2000, "Message cannot exceed 2000 characters"),
});

export type ICreateContactMessagePayload = z.infer<typeof CreateContactMessageZodSchema>;
