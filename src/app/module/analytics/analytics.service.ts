import httpStatus from "http-status"
import { Prisma } from "../../../generated/prisma/client"
import { AppointmentStatus, DoctorVerificationStatus, PaymentStatus, ScheduleStatus } from "../../../generated/prisma/enums"
import { prisma } from "../../lib/prisma"
import { RequestUser } from "../../middleware/checkAuth"
import { AppError } from "../../utils/AppError"

type TAppointmentScope = { doctorId?: string; patientId?: string }

// Pie chart: appointment count per status.
const getAppointmentsByStatus = async (scope: TAppointmentScope) => {
    const grouped = await prisma.apppointment.groupBy({
        by: ["status"],
        where: scope,
        _count: { _all: true },
    })

    return Object.values(AppointmentStatus).map((status) => ({
        status,
        count: grouped.find((item) => item.status === status)?._count._all ?? 0,
    }))
}

// Bar/line charts: appointments and paid revenue for each of the last 6 months.
const getMonthlyTrend = async (scope: TAppointmentScope) => {
    const scopeFilter = scope.doctorId
        ? Prisma.sql`AND a."doctorId" = ${scope.doctorId}`
        : scope.patientId
            ? Prisma.sql`AND a."patientId" = ${scope.patientId}`
            : Prisma.empty

    const rows = await prisma.$queryRaw<{ month: string; appointments: number; revenue: number }[]>`
        SELECT to_char(date_trunc('month', a."createdAt"), 'YYYY-MM') AS month,
               COUNT(*)::int AS appointments,
               COALESCE(SUM(CASE WHEN p.status = 'PAID' THEN p.amount ELSE 0 END), 0)::float AS revenue
        FROM appointments a
        LEFT JOIN payments p ON p."appointmentId" = a.id
        WHERE a."createdAt" >= date_trunc('month', now()) - interval '5 months'
        ${scopeFilter}
        GROUP BY 1
        ORDER BY 1`

    // Fill months with no activity so the chart always shows 6 points.
    const months: { month: string; appointments: number; revenue: number }[] = []
    const cursor = new Date()
    cursor.setDate(1)
    cursor.setMonth(cursor.getMonth() - 5)
    for (let i = 0; i < 6; i++) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`
        months.push(rows.find((row) => row.month === key) ?? { month: key, appointments: 0, revenue: 0 })
        cursor.setMonth(cursor.getMonth() + 1)
    }
    return months
}

const getAdminAnalytics = async () => {

    //total doctors

    const totalDoctors = await prisma.doctor.count({
        where : {
            isDeleted : false,
        }
    })

    const totalPendingDoctorApplications = await prisma.doctor.count({
        where: {
            isDeleted: false,
            verificationStatus : DoctorVerificationStatus.PENDING
        }
    })

    const totalApprovedDoctors = await prisma.doctor.count({
        where: {
            isDeleted: false,
            verificationStatus: DoctorVerificationStatus.APPROVED,
        },
    });
    const totalRejectedDoctors = await prisma.doctor.count({
        where: {
            isDeleted: false,
            verificationStatus: DoctorVerificationStatus.REJECTED,
        },
    });


    const totalPatients = await prisma.patient.count({
        where: { isDeleted: false },
    });

    const totalAppointments = await prisma.apppointment.count();

    const totalCompletedAppointments = await prisma.apppointment.count({
        where: { status: AppointmentStatus.COMPLETED },
    });

    const totalCancelledAppointments = await prisma.apppointment.count({
        where: { status: AppointmentStatus.CANCELLED },
    });

    const totalRefundResult = await prisma.payment.aggregate({
        where: {
            status: PaymentStatus.REFUNDED
        },
        _sum: {
            amount: true
        }
    })

    const totalRefunded = totalRefundResult._sum.amount?.toNumber() || 0

    const totalRevenueResult = await prisma.payment.aggregate({
        where : {
            status : PaymentStatus.PAID
        },
        _sum : {
            amount : true
        }
    })

    const totalRevenue = totalRevenueResult._sum.amount?.toNumber() || 0

    

    const charts = {
        appointmentsByStatus: await getAppointmentsByStatus({}),
        monthlyTrend: await getMonthlyTrend({}),
    }

    return {
        totalDoctors,
        totalPendingDoctorApplications,
        totalApprovedDoctors,
        totalRejectedDoctors,
        totalPatients,
        totalAppointments,
        totalCompletedAppointments,
        totalCancelledAppointments,
        totalRevenue,
        totalRefunded,
        charts
    }


}
const getPatientAnalytics = async (user : RequestUser) => {

    const patient = await prisma.patient.findUnique({
        where: { userId: user.userId },
    });

    if (!patient) {
        throw new AppError(httpStatus.NOT_FOUND, "Patient Profile Not Found");
    }

    const totalAppointments = await prisma.apppointment.count({
        where: { patientId: patient.id },
    });

    const upcomingAppointments = await prisma.apppointment.count({
        where: { patientId: patient.id, status: AppointmentStatus.CONFIRMED },
    });

    const completedAppointments = await prisma.apppointment.count({
        where: { patientId: patient.id, status: AppointmentStatus.COMPLETED },
    });

    const cancelledAppointments = await prisma.apppointment.count({
        where: { patientId: patient.id, status: AppointmentStatus.CANCELLED },
    });

    const totalAmountSpentResult = await prisma.payment.aggregate({
        where: {
            appointment: {
                patientId: patient.id,
            },
            status: PaymentStatus.PAID,
        },
        _sum: {
            amount: true,
        },
    });

    const totalAmountSpent = totalAmountSpentResult._sum.amount?.toNumber() || 0;

    const totalRefundedResult = await prisma.payment.aggregate({
        where: {
            appointment: {
                patientId: patient.id,
            },
            status: PaymentStatus.REFUNDED,
        },
        _sum: {
            amount: true,
        },
    });

    const totalRefunded = totalRefundedResult._sum.amount?.toNumber() || 0;

    const charts = {
        appointmentsByStatus: await getAppointmentsByStatus({ patientId: patient.id }),
        monthlyTrend: await getMonthlyTrend({ patientId: patient.id }),
    }

    return {
        totalAppointments,
        upcomingAppointments,
        completedAppointments,
        cancelledAppointments,
        totalAmountSpent,
        totalRefunded,
        charts
    }


}
const getDoctorAnalytics = async (user : RequestUser) => {
    const doctor = await prisma.doctor.findUnique({
        where: { userId: user.userId },
    });

    if (!doctor) {
        throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
    }

    const totalSchedules = await prisma.schedule.count({
        where: { doctorId: doctor.id, isDeleted: false },
    });

    const publishedSchedules = await prisma.schedule.count({
        where: {
            doctorId: doctor.id,
            isDeleted: false,
            status: ScheduleStatus.PUBLISHED,
        },
    });

    const totalAppointments = await prisma.apppointment.count({
        where: { doctorId: doctor.id },
    });

    const upcomingAppointments = await prisma.apppointment.count({
        where: { doctorId: doctor.id, status: AppointmentStatus.CONFIRMED },
    });

    const ongoingAppointments = await prisma.apppointment.count({
        where: { doctorId: doctor.id, status: AppointmentStatus.ONGOING },
    });

    const completedAppointments = await prisma.apppointment.count({
        where: { doctorId: doctor.id, status: AppointmentStatus.COMPLETED },
    });

    const cancelledAppointments = await prisma.apppointment.count({
        where: { doctorId: doctor.id, status: AppointmentStatus.CANCELLED },
    });

    const totalDoctorRefundedResult = await prisma.payment.aggregate({
        where: {
            appointment: {
                doctorId: doctor.id,
            },
            status: PaymentStatus.REFUNDED,
        },
        _sum: {
            amount: true,
        },
    });

    const totalDoctorRefunded = totalDoctorRefundedResult._sum.amount?.toNumber() || 0;

    const totalDoctorEarningsResult = await prisma.payment.aggregate({
        where: {
            appointment: {
                doctorId: doctor.id,
            },
            status: PaymentStatus.PAID,
        },
        _sum: {
            amount: true,
        },
    });

    const totalDoctorEarnings = totalDoctorEarningsResult._sum.amount?.toNumber() || 0;

    

    const charts = {
        appointmentsByStatus: await getAppointmentsByStatus({ doctorId: doctor.id }),
        monthlyTrend: await getMonthlyTrend({ doctorId: doctor.id }),
    }

    return {
        totalSchedules,
        publishedSchedules,
        totalAppointments,
        upcomingAppointments,
        ongoingAppointments,
        completedAppointments,
        cancelledAppointments,
        totalDoctorEarnings,
        totalDoctorRefunded,
        charts
    }

}

export const AnalyticsServices = {
    getAdminAnalytics,
    getPatientAnalytics,
    getDoctorAnalytics
}