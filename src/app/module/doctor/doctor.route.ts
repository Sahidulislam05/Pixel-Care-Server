import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { upload } from "../../lib/multer";
import { auth } from "../../middleware/checkAuth";
import { validateRequest } from "../../middleware/validateRequest";
import { DoctorController } from "./doctor.controller";
import {
	ApproveDoctorValidationZodSchema,
	UpdateDoctorProfileValidationZodSchema,
	VerifyDoctorEmailValidationZodSchema,
} from "./doctor.validation";

const router = Router();

router.post(
	"/apply-as-doctor",
	upload.fields([
		{
			name: "resume",
			maxCount: 1,
		},

		{
			name: "additionalFiles",
			maxCount: 10,
		},
	]),
	DoctorController.applyAsDoctor,
);
router.post(
	"/apply-as-doctor/verify-email",
	validateRequest(VerifyDoctorEmailValidationZodSchema),
	DoctorController.verifyDoctorEmail,
);
router.post(
	"/approve-doctor",
	auth(Role.ADMIN, Role.SUPER_ADMIN),
	validateRequest(ApproveDoctorValidationZodSchema),
	DoctorController.approveDoctor,
);
router.get(
	"/all-doctors",
	auth(Role.ADMIN, Role.SUPER_ADMIN),
	DoctorController.getAllDoctors,
);

router.patch(
	"/update-my-profile",
	auth(Role.DOCTOR),
	validateRequest(UpdateDoctorProfileValidationZodSchema),
	DoctorController.updateDoctorProfile,
);

// Public doctor-discovery routes (no auth) — meant for patients browsing before login.
router.get(
	"/public/available-today",
	DoctorController.getAvailableDoctorByTodaysSchedule,
);

router.get(
	"/public/all-doctors",
	DoctorController.getAllDoctorsListPublic,
);

router.get(
	"/public/:doctorId",
	DoctorController.getSingleDoctorPublicProfile,
);

export const DoctorRoutes = router;
