import type { Role, UserStatus } from "../../../generated/prisma/enums";

export interface IUpdateMyProfilePayload {
	name?: string;
	contactNumber?: string;
	address?: string;
}

export interface IUpdateUserStatusPayload {
	status: Extract<UserStatus, "ACTIVE" | "BLOCKED">;
}

export interface ICreateAdminPayload {
	name: string;
	email: string;
	personalEmail: string;
	role: Extract<Role, "ADMIN" | "SUPER_ADMIN">;
}
