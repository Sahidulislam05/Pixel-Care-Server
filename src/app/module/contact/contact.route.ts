import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import { validateRequest } from "../../middleware/validateRequest";
import { ContactController } from "./contact.controller";
import { CreateContactMessageZodSchema } from "./contact.validation";

const router = Router();

router.post(
	"/",
	validateRequest(CreateContactMessageZodSchema),
	ContactController.createContactMessage,
);

router.get("/", auth(Role.ADMIN, Role.SUPER_ADMIN), ContactController.getAllContactMessages);

export const ContactRoutes = router;
