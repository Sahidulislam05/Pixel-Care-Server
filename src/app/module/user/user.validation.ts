import z from "zod";

export const UpdateMyProfileZodSchema = z.object({
	name: z
		.string()
		.trim()
		.min(3, "Name must be at least 3 characters long")
		.max(50, "Name cannot exceed 50 characters")
		.optional(),
	contactNumber: z
		.string()
		.trim()
		.regex(/^\+?[0-9]{10,15}$/, "Contact number must be 10-15 digits")
		.optional(),
	address: z.string().trim().max(200, "Address cannot exceed 200 characters").optional(),
});

export const UpdateUserStatusZodSchema = z.object({
	status: z.enum(["ACTIVE", "BLOCKED"], "Status must be ACTIVE or BLOCKED"),
});

export const CreateAdminZodSchema = z.object({
	name: z.string().trim().min(3, "Name must be at least 3 characters long").max(50),
	email: z.email("Invalid organization email"),
	personalEmail: z.email("Invalid personal email"),
	role: z.enum(["ADMIN", "SUPER_ADMIN"], "Role must be ADMIN or SUPER_ADMIN").default("ADMIN"),
});
