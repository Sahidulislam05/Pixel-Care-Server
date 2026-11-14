import { addDays, differenceInMinutes, isAfter, isBefore, isSameDay, startOfDay } from "date-fns";
import httpStatus from "http-status";
import { AppointmentStatus, ScheduleStatus } from "../../../generated/prisma/enums";
import { ScheduleWhereInput } from "../../../generated/prisma/models";
import { IQuery } from "../../interfaces";
import { prisma } from "../../lib/prisma";
import { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { ICreateSchedulePayload, IUpdateSchedulePayload } from "./schedule.interface";


const MINUTES_ALLOCATED_PER_SLOT = 20
const MIN_SCHEDULE_HOURS = 3
const MAX_SCHEDULE_HOURS = 8

// Spec 6.1: same calendar day, start before end, 3-8 hours long.
// Returns the number of 20-minute slots in the range.
const validateTimeRange = (startDateTime: Date, endDateTime: Date) => {
    if (!isSameDay(startDateTime, endDateTime)) {
        throw new AppError(httpStatus.BAD_REQUEST, "Start Date Time And End Date Time Must Be On The Same Day")
    }

    if (!isAfter(endDateTime, startDateTime)) {
        throw new AppError(httpStatus.BAD_REQUEST, "End Date Time Must Be After Start Date Time")
    }

    if (isBefore(startDateTime, new Date())) {
        throw new AppError(httpStatus.BAD_REQUEST, "Schedule Cannot Start In The Past")
    }

    const durationInMinutes = differenceInMinutes(endDateTime, startDateTime)

    if (durationInMinutes < MIN_SCHEDULE_HOURS * 60 || durationInMinutes > MAX_SCHEDULE_HOURS * 60) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            `Schedule Must Be Between ${MIN_SCHEDULE_HOURS} And ${MAX_SCHEDULE_HOURS} Hours Long`,
        )
    }

    return Math.floor(durationInMinutes / MINUTES_ALLOCATED_PER_SLOT)
}

const assertNoOtherScheduleOnDate = async (doctorId: string, date: Date, excludeScheduleId?: string) => {
    const startOfTheDay = startOfDay(date)
    const startOfNextDay = addDays(startOfTheDay, 1)

    const existingScheduleOnThisDate = await prisma.schedule.findFirst({
        where: {
            doctorId,
            isDeleted: false,
            startDateTime: { gte: startOfTheDay, lt: startOfNextDay },
            ...(excludeScheduleId ? { id: { not: excludeScheduleId } } : {}),
        },
    })

    if (existingScheduleOnThisDate) {
        throw new AppError(httpStatus.CONFLICT, "You Already Have A Schedule For This Date")
    }
}

const createSchedule = async (payload : ICreateSchedulePayload , user : RequestUser) => {

    const doctor = await prisma.doctor.findUnique({
        where: { userId: user.userId },
    });

    if (!doctor) {
        throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
    }

    const totalSlots = validateTimeRange(payload.startDateTime, payload.endDateTime)
    await assertNoOtherScheduleOnDate(doctor.id, payload.startDateTime)

    const schedule = await prisma.schedule.create({
        data : {
            startDateTime : payload.startDateTime,
            endDateTime : payload.endDateTime,
            meetingLink : payload.meetingLink,
            totalSlots,
            availableSlots : totalSlots,
            doctorId : doctor.id
        },
        include : {
            doctor : {
                select : {
                    name : true,
                    email : true,
                    contactNumber : true
                }
            }
        }
    })

    return schedule
}

const getMySchedules = async (query : IQuery, user : RequestUser) => {

    const limit = query.limit ? Number(query.limit) : 10;
    const page = query.page ? Number(query.page) : 1;
    const skip = (page - 1) * limit;
    const sortBy = query.sortBy ? query.sortBy : "createdAt";
    const sortOrder = query.sortOrder ? query.sortOrder : "desc"

    const doctor = await prisma.doctor.findUnique({
        where: { userId: user.userId },
    });

    if (!doctor) {
        throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
    }

    // let limit = 10;
    // if (query.limit) {
    //     limit = Number(query.limit);
    // }

    // let page = 1;
    // if (query.page) {
    //     page = Number(query.page);
    // }

    // const skip = (page - 1) * limit;

    

    const andConditions: ScheduleWhereInput[] = [
        {
            doctorId : doctor.id
        },
        {
            isDeleted : false
        }
    ];

    if (query.status) {
        andConditions.push({ status: query.status });
    }

    const schedules = await prisma.schedule.findMany({
        where : {
            AND : andConditions
        },

        take: limit,
        skip,
        orderBy: {
            // sortBy : sortOrder
            [sortBy]: sortOrder
        },
        include : {
            appointments : {
                include : {
                    patient : true
                }
            }
        }
    })

    const total = await prisma.schedule.count({ where: { AND: andConditions } });

    return {
        data: schedules,
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };

}

const getAllSchedules = async (query : IQuery) => {

    const limit = query.limit ? Number(query.limit) : 10;
    const page = query.page ? Number(query.page) : 1;
    const skip = (page - 1) * limit;
    const sortBy = query.sortBy ? query.sortBy : "createdAt";
    const sortOrder = query.sortOrder ? query.sortOrder : "desc"

    const andConditions: ScheduleWhereInput[] = [];

    if (query.doctorId) {
        andConditions.push({ doctorId: query.doctorId });
    }
    if (query.email) {
        andConditions.push({ doctor : {
            email : query.email
        } });
    }

    if (query.status) {
        andConditions.push({ status: query.status });
    }

    if (query.searchTerm) {
        andConditions.push({
            doctor: {
                OR: [
                    { name: { contains: query.searchTerm, mode: "insensitive" } },
                    { email: { contains: query.searchTerm, mode: "insensitive" } },
                    {
                        specialization: { contains: query.searchTerm, mode: "insensitive" },
                    },
                ],
            },
        });
    };

    const schedules = await prisma.schedule.findMany({
        where: {
            AND: andConditions
        },

        take: limit,
        skip,
        orderBy: {
            // sortBy : sortOrder
            [sortBy]: sortOrder
        },
        include: {
            appointments: {
                include: {
                    patient: true
                }
            }
        }
    })

    const total = await prisma.schedule.count({ where: { AND: andConditions } });

    return {
        data: schedules,
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };

}

const getScheduleById = async (scheduleId : string) => {

    const schedule = await prisma.schedule.findUnique({
        where: { id: scheduleId },
        include: {
            doctor: {
                select: {
                    id: true,
                    name: true,
                    email: true,
                    specialization: true,
                    userId: true,
                },
            },
            appointments: {
                include: {
                    patient: true
                },
            }
        },
    });

    if(!schedule || schedule.isDeleted){
        throw new AppError(httpStatus.NOT_FOUND, "Schedule Not Found");
    }

    return schedule

}

const updateSchedule = async (scheduleId : string, payload : IUpdateSchedulePayload, user : RequestUser) => {

    const doctor = await prisma.doctor.findUnique({
        where: { userId: user.userId },
    });

    if (!doctor) {
        throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
    }

    const schedule = await prisma.schedule.findUnique({
        where : { id : scheduleId, doctorId : doctor.id}
    })

    if (!schedule || schedule.isDeleted) {
        throw new AppError(httpStatus.NOT_FOUND, "Schedule Not Found");
    }

    const isPublished = schedule.status === ScheduleStatus.PUBLISHED
    const hasBookings = (await prisma.apppointment.count({
        where: { scheduleId: schedule.id, status: { not: AppointmentStatus.CANCELLED } },
    })) > 0

    const isChangingTime = Boolean(payload.startDateTime || payload.endDateTime)

    // Spec 6.2: meet link can always change; the time range locks once a slot
    // is booked; the date locks once the schedule is published.
    if (!isChangingTime) {
        return prisma.schedule.update({
            where: { id: schedule.id },
            data: { meetingLink: payload.meetingLink ?? schedule.meetingLink },
        })
    }

    if (hasBookings) {
        throw new AppError(httpStatus.CONFLICT, "Time Range Cannot Be Changed After An Appointment Is Booked")
    }

    const startDateTime = payload.startDateTime ?? schedule.startDateTime
    const endDateTime = payload.endDateTime ?? schedule.endDateTime

    if (isPublished && !isSameDay(startDateTime, schedule.startDateTime)) {
        throw new AppError(httpStatus.CONFLICT, "Date Of A Published Schedule Cannot Be Changed")
    }

    const totalSlots = validateTimeRange(startDateTime, endDateTime)
    await assertNoOtherScheduleOnDate(doctor.id, startDateTime, schedule.id)

    const updatedSchedule = await prisma.schedule.update({
        where : {
            id : schedule.id
        },
        data: {
            startDateTime,
            endDateTime,
            meetingLink: payload.meetingLink ?? schedule.meetingLink,
            totalSlots,
            availableSlots: totalSlots,
        },
        include: {
            doctor: {
                select: {
                    name: true,
                    email: true,
                    contactNumber: true
                }
            }
        }
    })

    return updatedSchedule
}

const publishSchedule = async (scheduleId : string, user : RequestUser) => {
    const doctor = await prisma.doctor.findUnique({
        where: { userId: user.userId },
    });

    if (!doctor) {
        throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
    }

    const schedule = await prisma.schedule.findUnique({
        where: { id: scheduleId, doctorId : doctor.id },
    });

    if (!schedule || schedule.isDeleted) {
        throw new AppError(httpStatus.NOT_FOUND, "Schedule Not Found");
    }

    if (schedule.status === ScheduleStatus.PUBLISHED) {
        throw new AppError(httpStatus.CONFLICT, "Schedule Is Already Published");
    }

    const publishedSchedule = await prisma.schedule.update({
        where: { id: schedule.id },
        data: { status: ScheduleStatus.PUBLISHED },
    });

    return publishedSchedule;
}

const deleteSchedule = async (scheduleId: string, user: RequestUser) => {
    const doctor = await prisma.doctor.findUnique({
        where: { userId: user.userId },
    });

    if (!doctor) {
        throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
    }

    const schedule = await prisma.schedule.findUnique({
        where: { id: scheduleId, doctorId: doctor.id },
    });

    if (!schedule || schedule.isDeleted) {
        throw new AppError(httpStatus.NOT_FOUND, "Schedule Not Found");
    }

    const activeBookings = await prisma.apppointment.count({
        where: { scheduleId: schedule.id, status: { not: AppointmentStatus.CANCELLED } },
    });

    if (activeBookings > 0) {
        throw new AppError(httpStatus.CONFLICT, "Schedule With Booked Appointments Cannot Be Deleted");
    };

    const deletedSchedule = await prisma.schedule.update({
        where: { id: schedule.id },
        data: { isDeleted: true, deletedAt: new Date() },
    });

    return deletedSchedule;
}


const getTodaysSchedules = async (query : IQuery) => {
    if(!query.doctorId){
        throw new AppError(httpStatus.BAD_REQUEST, "Doctor Id Must Be Provided In Query")
    }

    const doctor = await prisma.doctor.findUnique({
        where: { id : query.doctorId },
    });

    if (!doctor) {
        throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
    }

    const limit = query.limit ? Number(query.limit) : 10;
    const page = query.page ? Number(query.page) : 1;
    const skip = (page - 1) * limit;
    const sortBy = query.sortBy ? query.sortBy : "createdAt";
    const sortOrder = query.sortOrder ? query.sortOrder : "desc"

    const now = new Date();
    const startOfToday = startOfDay(now);
    const startOfTomorrow = addDays(startOfToday, 1)

    const andConditions: ScheduleWhereInput[] = [
        {
            doctorId : query.doctorId
        },
        {
            isDeleted : false
        },
        {
            status : ScheduleStatus.PUBLISHED
        },
        {
            startDateTime : {
                gt : now,
                lt : startOfTomorrow,
            }
        },
        {
            availableSlots : { gt : 0}
        }
    ];

    const schedules = await prisma.schedule.findMany({
        where: {
            AND: andConditions
        },

        take: limit,
        skip,
        orderBy: {
            // sortBy : sortOrder
            [sortBy]: sortOrder
        }
    })

    const total = await prisma.schedule.count({ where: { AND: andConditions } });

    return {
        data: schedules,
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}



export const ScheduleServices = {
    createSchedule,
    getMySchedules,
    getAllSchedules,
    getScheduleById,
    updateSchedule,
    publishSchedule,
    deleteSchedule,
    getTodaysSchedules
}