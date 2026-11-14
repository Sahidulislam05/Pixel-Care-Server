import { addMinutes, isBefore, isSameDay, subHours } from "date-fns";
import httpStatus from "http-status";
import PDFDocument from "pdfkit";
import {
  AppointmentStatus,
  PaymentStatus,
  Role,
  ScheduleStatus,
} from "../../../generated/prisma/enums";
import { ApppointmentWhereInput } from "../../../generated/prisma/models";
import config from "../../config";
import { IQuery } from "../../interfaces";
import {
  createBkashPayment,
  executeBkashPayment,
  refundBkashPayment,
} from "../../lib/bkash";
import { transporter } from "../../lib/nodemailer";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import {
  IBookAppointmentPayload,
  ICancelAppointmentPayload,
  IPayAppointmentPayload,
  IUpdateAppointmentStatusPayload,
} from "./appointment.interface";

const MINUTES_PER_SLOT = 20;

type TPayableAppointment = {
  id: string;
  schedule: {
    startDateTime: Date;
    availableSlots: number;
    isDeleted: boolean;
    status: ScheduleStatus;
  };
};

// A schedule can be booked/paid only today, before it starts, while slots remain.
const assertScheduleIsBookable = (schedule: TPayableAppointment["schedule"]) => {
  const now = new Date();

  if (schedule.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, "Schedule Not Found");
  }

  if (schedule.status !== ScheduleStatus.PUBLISHED) {
    throw new AppError(httpStatus.BAD_REQUEST, "This Schedule Is Not Published Yet");
  }

  if (!isSameDay(now, schedule.startDateTime)) {
    throw new AppError(httpStatus.BAD_REQUEST, "This Schedule Is Not Available Today");
  }

  if (!isBefore(now, schedule.startDateTime)) {
    throw new AppError(httpStatus.BAD_REQUEST, "This Schedule Has Already Started");
  }

  if (schedule.availableSlots <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "This Schedule Is Fully Booked");
  }
};

// Starts a bKash checkout for a PENDING appointment and stores the payment row.
const startAppointmentPayment = async (
  appointmentId: string,
  amount: string,
  payerEmail: string,
) => {
  const bkashPayment = await createBkashPayment({
    amount,
    invoiceNumber: appointmentId,
    payerReference: payerEmail,
  });

  await prisma.payment.upsert({
    where: { appointmentId },
    create: {
      appointmentId,
      merchantInvoiceNumber: appointmentId,
      amount,
      bkashPaymentId: bkashPayment.paymentID,
      payerReference: payerEmail,
      gatewayResponse: bkashPayment,
    },
    update: {
      status: PaymentStatus.UNPAID,
      amount,
      bkashPaymentId: bkashPayment.paymentID,
      gatewayResponse: bkashPayment,
    },
  });

  return { appointmentId, paymentUrl: bkashPayment.bkashURL };
};

const bookAppointment = async (
  payload: IBookAppointmentPayload,
  user: RequestUser,
) => {
  const patient = await prisma.patient.findUnique({
    where: { userId: user.userId },
  });

  if (!patient) {
    throw new AppError(httpStatus.NOT_FOUND, "Patient Profile Not Found");
  }

  const schedule = await prisma.schedule.findUnique({
    where: { id: payload.scheduleId },
    include: { doctor: true },
  });

  if (!schedule) {
    throw new AppError(httpStatus.NOT_FOUND, "Schedule Not Found");
  }

  assertScheduleIsBookable(schedule);

  if (!schedule.doctor.consultationFee) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Doctor Has Not Set A Consultation Fee Yet",
    );
  }

  const amount = schedule.doctor.consultationFee.toString();

  const existingAppointment = await prisma.apppointment.findFirst({
    where: { patientId: patient.id, scheduleId: schedule.id },
  });

  if (existingAppointment) {
    switch (existingAppointment.status) {
      case AppointmentStatus.PENDING:
        // Unpaid booking already exists: just start a fresh payment for it.
        return startAppointmentPayment(existingAppointment.id, amount, user.email);
      case AppointmentStatus.CANCELLED:
        throw new AppError(
          httpStatus.BAD_REQUEST,
          "You Cancelled An Appointment On This Schedule. Please Choose Another Schedule",
        );
      default:
        throw new AppError(
          httpStatus.BAD_REQUEST,
          "You Already Have An Appointment On This Schedule",
        );
    }
  }

  const appointment = await prisma.apppointment.create({
    data: {
      status: AppointmentStatus.PENDING,
      patientId: patient.id,
      doctorId: schedule.doctor.id,
      scheduleId: schedule.id,
    },
  });

  try {
    return await startAppointmentPayment(appointment.id, amount, user.email);
  } catch (error) {
    // Payment never started, so don't leave an orphan PENDING appointment behind.
    await prisma.apppointment.delete({ where: { id: appointment.id } });
    throw error;
  }
};

// Retry payment for the patient's own PENDING appointment.
const payAppointment = async (
  payload: IPayAppointmentPayload,
  user: RequestUser,
) => {
  const existingAppointment = await prisma.apppointment.findUnique({
    where: { id: payload.appointmentId },
    include: {
      patient: { select: { userId: true } },
      schedule: { include: { doctor: true } },
    },
  });

  if (!existingAppointment || existingAppointment.patient.userId !== user.userId) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment Does Not Exists");
  }

  if (existingAppointment.status !== AppointmentStatus.PENDING) {
    throw new AppError(httpStatus.BAD_REQUEST, "Appointment Is Not Pending!");
  }

  assertScheduleIsBookable(existingAppointment.schedule);

  if (!existingAppointment.schedule.doctor.consultationFee) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Doctor Has Not Set A Consultation Fee Yet",
    );
  }

  return startAppointmentPayment(
    existingAppointment.id,
    existingAppointment.schedule.doctor.consultationFee.toString(),
    user.email,
  );
};

const buildInvoicePdf = (details: {
  patientName: string;
  patientEmail: string;
  doctorName: string;
  specialization: string;
  startDateTime: Date;
  joiningTime: Date;
  serialNumber: number;
  meetingLink: string;
  amount: string;
  trxId: string;
  paidAt: string;
}) => {
  const pdfDocument = new PDFDocument({ margin: 50 });
  const pdfChunks: Buffer[] = [];

  pdfDocument.on("data", (chunk: Buffer) => pdfChunks.push(chunk));

  const pdfReady = new Promise<Buffer>((resolve) => {
    pdfDocument.on("end", () => resolve(Buffer.concat(pdfChunks)));
  });

  pdfDocument.fontSize(20).text("Pixel-care System", { align: "center" });
  pdfDocument.fontSize(14).text("Appointment Invoice", { align: "center" });
  pdfDocument.moveDown(2);

  pdfDocument.fontSize(12).text(`Patient Name: ${details.patientName}`);
  pdfDocument.text(`Patient Email: ${details.patientEmail}`);
  pdfDocument.moveDown();

  pdfDocument.text(`Doctor Name: ${details.doctorName}`);
  pdfDocument.text(`Specialization: ${details.specialization}`);
  pdfDocument.moveDown();

  pdfDocument.text(`Appointment Date: ${details.startDateTime.toDateString()}`);
  pdfDocument.text(`Your Joining Time: ${details.joiningTime.toString()}`);
  pdfDocument.text(`Your Serial Number: ${details.serialNumber}`);
  pdfDocument.text(`Meeting Link: ${details.meetingLink}`);
  pdfDocument.moveDown();

  pdfDocument.text(`Amount Paid: ${details.amount} BDT`);
  pdfDocument.text("Payment Method: bKash");
  pdfDocument.text(`Transaction Id: ${details.trxId}`);
  pdfDocument.text(`Paid At: ${details.paidAt}`);

  pdfDocument.end();

  return pdfReady;
};

const appointmentsPageUrl = (status: string) =>
  `${config.frontend_url}/dashboard/my-appointments?status=${status}`;

// bKash redirects the patient's browser here. It must always answer with a
// redirect back to the frontend, never with JSON.
const bookAppointmentCallback = async (query: Record<string, any>) => {
  try {
    const paymentId = query.paymentID as string | undefined;
    const status = query.status as string | undefined;

    if (!paymentId || !status) {
      return { redirectUrl: appointmentsPageUrl("error") };
    }

    if (status !== "success") {
      await prisma.payment.updateMany({
        where: { bkashPaymentId: paymentId, status: PaymentStatus.UNPAID },
        data: {
          status: status === "cancel" ? PaymentStatus.CANCELLED : PaymentStatus.FAILED,
        },
      });
      return { redirectUrl: appointmentsPageUrl(status === "cancel" ? "cancel" : "failure") };
    }

    const payment = await prisma.payment.findUnique({
      where: { bkashPaymentId: paymentId },
      include: {
        appointment: {
          include: { schedule: true, patient: true, doctor: true },
        },
      },
    });

    if (!payment) {
      return { redirectUrl: appointmentsPageUrl("error") };
    }

    // bKash may call back more than once; the first one already did the work.
    if (payment.status === PaymentStatus.PAID) {
      return { redirectUrl: appointmentsPageUrl("success") };
    }

    const { result: executed, isCompleted } = await executeBkashPayment(paymentId);

    if (!isCompleted) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED, gatewayResponse: executed },
      });
      return { redirectUrl: appointmentsPageUrl("failure") };
    }

    const { appointment } = payment;
    const { schedule } = appointment;

    const confirmed = await prisma.$transaction(async (tx) => {
      // Row-locking, conditional decrement: two payers can't both take the last slot.
      const slotTaken = await tx.schedule.updateMany({
        where: { id: schedule.id, availableSlots: { gt: 0 } },
        data: { availableSlots: { decrement: 1 } },
      });

      if (slotTaken.count === 0) {
        return null;
      }

      // Lowest serial not held by an active booking (cancelled ones release theirs).
      const takenSerials = await tx.apppointment.findMany({
        where: { scheduleId: schedule.id, serialNumber: { not: null } },
        select: { serialNumber: true },
      });
      const taken = new Set(takenSerials.map((item) => item.serialNumber));
      let serialNumber = 1;
      while (taken.has(serialNumber)) serialNumber++;

      const joiningTime = addMinutes(
        schedule.startDateTime,
        (serialNumber - 1) * MINUTES_PER_SLOT,
      );

      await tx.apppointment.update({
        where: { id: appointment.id },
        data: { status: AppointmentStatus.CONFIRMED, serialNumber, joiningTime },
      });

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PAID,
          bkashTrxId: executed.trxID,
          paidAt: executed.paymentExecuteTime,
          gatewayResponse: executed,
        },
      });

      return { serialNumber, joiningTime };
    });

    if (!confirmed) {
      // Money was taken but the schedule filled up meanwhile: give it back.
      const refund = await refundBkashPayment({
        paymentId,
        trxId: executed.trxID,
        amount: payment.amount.toString(),
        reason: "Schedule Fully Booked",
      });

      await prisma.$transaction([
        prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.REFUNDED,
            bkashTrxId: executed.trxID,
            paidAt: executed.paymentExecuteTime,
            refundTrxId: refund.refundTrxID,
            refundAmount: refund.amount,
            refundedAt: refund.completedTime,
            refundReason: "Schedule Fully Booked",
            gatewayResponse: refund,
          },
        }),
        prisma.apppointment.update({
          where: { id: appointment.id },
          data: { status: AppointmentStatus.CANCELLED },
        }),
      ]);

      return { redirectUrl: appointmentsPageUrl("full") };
    }

    // The booking is saved; a mail failure must not turn it into an error.
    try {
      const pdfBuffer = await buildInvoicePdf({
        patientName: appointment.patient.name,
        patientEmail: appointment.patient.email,
        doctorName: appointment.doctor.name,
        specialization: appointment.doctor.specialization,
        startDateTime: schedule.startDateTime,
        joiningTime: confirmed.joiningTime,
        serialNumber: confirmed.serialNumber,
        meetingLink: schedule.meetingLink,
        amount: String(executed.amount),
        trxId: executed.trxID,
        paidAt: executed.paymentExecuteTime,
      });

      await transporter.sendMail({
        from: config.email_sender,
        to: appointment.patient.email,
        subject: "Your Appointment Invoice - Pixel-care System",
        text: "Thank you for booking an appointment. Please find your invoice attached.",
        attachments: [{ filename: "invoice.pdf", content: pdfBuffer }],
      });
    } catch (error) {
      console.error("Appointment: invoice email failed", error);
    }

    return { redirectUrl: appointmentsPageUrl("success") };
  } catch (error) {
    console.error("Appointment: payment callback failed", error);
    return { redirectUrl: appointmentsPageUrl("error") };
  }
};

const REFUND_CUTOFF_HOURS = 1;

// Patients cancel their own appointments; admins can cancel any.
// Spec: refund only if cancelled more than 1 hour before the schedule starts.
const cancelAppointment = async (
  payload: ICancelAppointmentPayload,
  user: RequestUser,
) => {
  const existingAppointment = await prisma.apppointment.findUnique({
    where: { id: payload.appointmentId },
    include: {
      payment: true,
      schedule: true,
      patient: { select: { userId: true } },
    },
  });

  const isPatient = user.role === Role.PATIENT;

  if (
    !existingAppointment ||
    (isPatient && existingAppointment.patient.userId !== user.userId)
  ) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment Does Not Exists");
  }

  if (existingAppointment.status === AppointmentStatus.CANCELLED) {
    throw new AppError(httpStatus.BAD_REQUEST, "Appointment Already Cancelled");
  }

  if (
    existingAppointment.status === AppointmentStatus.ONGOING ||
    existingAppointment.status === AppointmentStatus.COMPLETED
  ) {
    throw new AppError(httpStatus.BAD_REQUEST, "Appointment Ongoing or Completed");
  }

  const { payment, schedule } = existingAppointment;
  const refundCutOffTime = subHours(schedule.startDateTime, REFUND_CUTOFF_HOURS);

  const shouldRefund =
    payment?.status === PaymentStatus.PAID &&
    Boolean(payment.bkashPaymentId && payment.bkashTrxId) &&
    isBefore(new Date(), refundCutOffTime);

  const refundReason = isPatient
    ? "Patient Cancelled The Appointment"
    : "Appointment Cancelled By Admin";

  // Refund first: if bKash refuses, the appointment stays as it was.
  const refund = shouldRefund
    ? await refundBkashPayment({
        paymentId: payment!.bkashPaymentId!,
        trxId: payment!.bkashTrxId!,
        amount: payment!.amount.toString(),
        reason: refundReason,
      })
    : null;

  return prisma.$transaction(async (tx) => {
    const updatedAppointment = await tx.apppointment.update({
      where: { id: existingAppointment.id },
      // Free the serial number so the slot can be booked again.
      data: { status: AppointmentStatus.CANCELLED, serialNumber: null, joiningTime: null },
    });

    // Only a confirmed booking ever took a slot.
    if (existingAppointment.status === AppointmentStatus.CONFIRMED) {
      await tx.schedule.update({
        where: { id: schedule.id },
        data: { availableSlots: { increment: 1 } },
      });
    }

    let updatedPayment = payment;

    if (payment && refund) {
      updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.REFUNDED,
          refundTrxId: refund.refundTrxID,
          refundedAt: refund.completedTime,
          refundAmount: refund.amount,
          refundReason,
          gatewayResponse: refund,
        },
      });
    } else if (payment && payment.status === PaymentStatus.UNPAID) {
      updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.CANCELLED },
      });
    }

    return {
      appointment: updatedAppointment,
      payment: updatedPayment,
      refunded: Boolean(refund),
    };
  });
};

// DOCTOR ONLY CONFIRMED => ONGOING => COMPLETED
const updateAppointmentStatus = async (
  appointmentId: string,
  payload: IUpdateAppointmentStatusPayload,
  user: RequestUser,
) => {
  const doctor = await prisma.doctor.findUnique({
    where: { userId: user.userId },
  });

  if (!doctor) {
    throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
  }

  const appointment = await prisma.apppointment.findUnique({
    where: { id: appointmentId, doctorId: doctor.id },
  });

  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment Not Found");
  }

  if (appointment.status === AppointmentStatus.COMPLETED) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Appointment is already completed",
    );
  }

  if (appointment.status === AppointmentStatus.CANCELLED) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Appointment is already cancelled",
    );
  }
  if (appointment.status === AppointmentStatus.PENDING) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Appointment is Pending. You can change the status after appointment is confirmed",
    );
  }

  if (appointment.status === AppointmentStatus.CONFIRMED) {
    if (payload.status !== "ONGOING") {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Confirmed Appointment Must Be Ongoing At First",
      );
    }

    await prisma.apppointment.update({
      where: {
        id: appointment.id,
      },
      data: {
        status: AppointmentStatus.ONGOING,
      },
    });
  }

  if (appointment.status === AppointmentStatus.ONGOING) {
    if (payload.status !== "COMPLETED") {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Ongoing Appointment Must Be Completed.",
      );
    }

    await prisma.apppointment.update({
      where: {
        id: appointment.id,
      },
      data: {
        status: AppointmentStatus.COMPLETED,
      },
    });
  }

  const updatedAppointment = await prisma.apppointment.findUnique({
    where: {
      id: appointment.id,
    },
  });

  return updatedAppointment;
};

//patient appointments
const getMyAppointments = async (query: IQuery, user: RequestUser) => {
  const limit = query.limit ? Number(query.limit) : 10;
  const page = query.page ? Number(query.page) : 1;
  const skip = (page - 1) * limit;
  const sortBy = query.sortBy ? query.sortBy : "createdAt";
  const sortOrder = query.sortOrder ? query.sortOrder : "desc";

  const patient = await prisma.patient.findUnique({
    where: { userId: user.userId },
  });

  if (!patient) {
    throw new AppError(httpStatus.NOT_FOUND, "Patient Profile Not Found");
  }

  const andConditions: ApppointmentWhereInput[] = [
    {
      patientId: patient.id,
    },
  ];

  if (query.status) {
    andConditions.push({ status: query.status });
  }

  const appointments = await prisma.apppointment.findMany({
    where: { AND: andConditions },
    take: limit,
    skip,
    orderBy: { [sortBy]: sortOrder },
    include: {
      doctor: { select: { id: true, name: true, specialization: true } },
      schedule: true,
      payment: true,
    },
  });

  const total = await prisma.apppointment.count({
    where: { AND: andConditions },
  });

  return {
    data: appointments,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

//doctor appointments
const getDoctorAppointments = async (query: IQuery, user: RequestUser) => {
  const limit = query.limit ? Number(query.limit) : 10;
  const page = query.page ? Number(query.page) : 1;
  const skip = (page - 1) * limit;
  const sortBy = query.sortBy ? query.sortBy : "createdAt";
  const sortOrder = query.sortOrder ? query.sortOrder : "desc";

  const doctor = await prisma.doctor.findUnique({
    where: { userId: user.userId },
  });

  if (!doctor) {
    throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
  }

  const andConditions: ApppointmentWhereInput[] = [
    {
      doctorId: doctor.id,
    },
  ];

  if (query.status) {
    andConditions.push({ status: query.status });
  }

  const appointments = await prisma.apppointment.findMany({
    where: { AND: andConditions },
    take: limit,
    skip,
    orderBy: { [sortBy]: sortOrder },
    include: {
      patient: {
        select: { id: true, name: true, email: true, contactNumber: true },
      },
      schedule: true,
      payment: true,
    },
  });

  const total = await prisma.apppointment.count({
    where: { AND: andConditions },
  });

  return {
    data: appointments,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

//admin super admin
const getAllAppointments = async (query: IQuery) => {
  const limit = query.limit ? Number(query.limit) : 10;
  const page = query.page ? Number(query.page) : 1;
  const skip = (page - 1) * limit;
  const sortBy = query.sortBy ? query.sortBy : "createdAt";
  const sortOrder = query.sortOrder ? query.sortOrder : "desc";

  const andConditions: ApppointmentWhereInput[] = [];

  if (query.status) {
    andConditions.push({ status: query.status });
  }

  if (query.doctorId) {
    andConditions.push({ doctorId: query.doctorId });
  }

  if (query.patientId) {
    andConditions.push({ patientId: query.patientId });
  }

  if (query.doctorEmail) {
    andConditions.push({
      doctor: {
        email: query.doctorEmail,
      },
    });
  }
  if (query.patientEmail) {
    andConditions.push({
      patient: {
        email: query.patientEmail,
      },
    });
  }

  const appointments = await prisma.apppointment.findMany({
    where: { AND: andConditions },
    take: limit,
    skip,
    orderBy: { [sortBy]: sortOrder },
    include: {
      patient: { select: { id: true, name: true, email: true } },
      doctor: { select: { id: true, name: true, specialization: true } },
      schedule: true,
      payment: true,
    },
  });

  const total = await prisma.apppointment.count({
    where: { AND: andConditions },
  });

  return {
    data: appointments,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// for all loggedin user
const getSingleAppointment = async (
  appointmentId: string,
  user: RequestUser,
) => {
  const appointment = await prisma.apppointment.findUnique({
    where: { id: appointmentId },
    include: {
      patient: { select: { id: true, name: true, email: true, userId: true } },
      doctor: {
        select: { id: true, name: true, specialization: true, userId: true },
      },
      schedule: true,
      payment: true,
    },
  });

  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment Not Found");
  }

  if (user.role === Role.PATIENT) {
    if (appointment.patient.userId !== user.userId) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "You Are Not Allowed To View This Appointment",
      );
    }
  }
  if (user.role === Role.DOCTOR) {
    if (appointment.doctor.userId !== user.userId) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "You Are Not Allowed To View This Appointment",
      );
    }
  }

  return appointment;
};

export const AppointmentServices = {
  bookAppointment,
  payAppointment,
  bookAppointmentCallback,
  cancelAppointment,
  updateAppointmentStatus,
  getMyAppointments,
  getDoctorAppointments,
  getAllAppointments,
  getSingleAppointment,
};
