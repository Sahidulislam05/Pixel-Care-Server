import cookieParser from "cookie-parser";
import cors from "cors";
import express, {
  type Application,
  type Request,
  type Response,
} from "express";
import httpStatus from "http-status";
import config from "./app/config";
import { globalErrorHandler } from "./app/middleware/globalErrorHandler";
import { notFound } from "./app/middleware/notFound";
import { AnalyticsRoutes } from "./app/module/analytics/analytics.route";
import { AppointementRoutes } from "./app/module/appointment/appointment.route";
import { AuthRoutes } from "./app/module/auth/auth.route";
import { DoctorRoutes } from "./app/module/doctor/doctor.route";
import { PaymentRoutes } from "./app/module/payment/payment.route";
import { PrescriptionRoutes } from "./app/module/prescription/prescription.route";
import { ScheduleRoutes } from "./app/module/schedule/schedule.route";
import { UserRoutes } from "./app/module/user/user.route";
import { ChatRoutes } from "./app/module/chat/chat.route";
import { ContactRoutes } from "./app/module/contact/contact.route";

const app: Application = express();

// Render/Vercel sit behind a proxy; needed so secure cookies work in production.
app.set("trust proxy", 1);

app.use(
  cors({
    origin: config.frontend_url,
    credentials: true,
  }),
);

// Enable URL-encoded form data parsing
app.use(express.urlencoded({ extended: true }));

// Middleware to parse JSON bodies
app.use(express.json());
app.use(cookieParser());

app.use("/api/v1/auth", AuthRoutes);
app.use("/api/v1/user", UserRoutes);
app.use("/api/v1/appointment", AppointementRoutes);
app.use("/api/v1/doctor", DoctorRoutes);
app.use("/api/v1/schedule", ScheduleRoutes);
app.use("/api/v1/payment", PaymentRoutes);
app.use("/api/v1/prescription", PrescriptionRoutes);
app.use("/api/v1/analytics", AnalyticsRoutes);
//RAG implemented chat router
app.use("/api/v1/chat", ChatRoutes);
app.use("/api/v1/contact", ContactRoutes);

// Basic route
app.get("/", async (req: Request, res: Response) => {
  res.status(httpStatus.OK).json({
    success: true,
    message: "Welcome to Pixel-care System Backend",
  });
});

app.use(globalErrorHandler);
app.use(notFound);

export default app;
