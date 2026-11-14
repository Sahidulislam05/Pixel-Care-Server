import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { upload } from "../../lib/multer";
import { auth } from "../../middleware/checkAuth";
import { validateRequest } from "../../middleware/validateRequest";
import { UserController } from "./user.controller";
import {
	CreateAdminZodSchema,
	UpdateMyProfileZodSchema,
	UpdateUserStatusZodSchema,
} from "./user.validation";

const router = Router();

const allRoles = [Role.SUPER_ADMIN, Role.ADMIN, Role.DOCTOR, Role.PATIENT];

router.patch(
	"/profile-image",
	auth(...allRoles),
	upload.single("profileImage"),
	UserController.uploadProfileImage,
);

router.patch(
	"/me",
	auth(...allRoles),
	validateRequest(UpdateMyProfileZodSchema),
	UserController.updateMyProfile,
);

router.get("/", auth(Role.ADMIN, Role.SUPER_ADMIN), UserController.getAllUsers);

router.post(
	"/create-admin",
	auth(Role.ADMIN, Role.SUPER_ADMIN),
	validateRequest(CreateAdminZodSchema),
	UserController.createAdmin,
);

router.patch(
	"/:userId/status",
	auth(Role.ADMIN, Role.SUPER_ADMIN),
	validateRequest(UpdateUserStatusZodSchema),
	UserController.updateUserStatus,
);

export const UserRoutes = router;
