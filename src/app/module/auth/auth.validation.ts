import z from "zod";

const PatientRegistrationZodSchema = z.object({
	name: z
		.string("Not A String!!!!!")
		.trim()
		.min(3, "Name must be at least 3 characters long")
		.max(50, "Name cannot exceed 50 characters"),
	email: z.email("Not email!!"),
	password: z
		.string()
		.min(8, "Password Must Minimum 8 Characters Long.")
		.regex(/[a-z]/, "Password must contain atleast 1 Lowercase Letter")
		.regex(/[A-Z]/, "Password must contain atleast 1 Uppercase Letter")

		.regex(/[0-9]/, "Password must contain atleast 1 Number")
		.regex(/[^A-Za-z0-9]/, "Password must contain atleast 1 Special Character"),
	patient: z
		.object({
			contactNumber: z.string().optional(),
		})
		.optional(),
});
const PatientEmailVerifyZodSchema = z.object({
	email: z.email("Not email!!"),
	otp: z.string().length(6),
});

// Login only checks presence; strength rules belong to registration/reset.
const LoginZodSchema = z.object({
	email: z.email("Invalid email address"),
	password: z.string().min(1, "Password is required"),
});

const ForgotPasswordZodSchema = z.object({
	email: z.email(),
});

const ResetPasswordZodSchema = z.object({
	email: z.email(),
	newPassword: z
		.string()
		.min(8, "Password Must Minimum 8 Characters Long.")
		.regex(/[a-z]/, "Password must contain atleast 1 Lowercase Letter")
		.regex(/[A-Z]/, "Password must contain atleast 1 Uppercase Letter")

		.regex(/[0-9]/, "Password must contain atleast 1 Number")
		.regex(/[^A-Za-z0-9]/, "Password must contain atleast 1 Special Character"),
	otp: z.string().length(6),
});

const ChangePasswordZodSchema = z.object({
	currentPassword: z.string().min(1).optional(),
	newPassword: z
		.string()
		.min(8, "Password Must Minimum 8 Characters Long.")
		.regex(/[a-z]/, "Password must contain atleast 1 Lowercase Letter")
		.regex(/[A-Z]/, "Password must contain atleast 1 Uppercase Letter")
		.regex(/[0-9]/, "Password must contain atleast 1 Number")
		.regex(/[^A-Za-z0-9]/, "Password must contain atleast 1 Special Character"),
});

const GoogleLoginZodSchema = z.object({
	idToken: z.string("Google id token is required").min(1, "Google id token is required"),
});

export const UserValidation = {
	ChangePasswordZodSchema,
	GoogleLoginZodSchema,
	PatientRegistrationZodSchema,
	PatientEmailVerifyZodSchema,
	LoginZodSchema,
	ForgotPasswordZodSchema,
	ResetPasswordZodSchema,
};
