import app from "./app";
import config from "./app/config";
import {
  deleteUnverifiedDoctors,
  reindexDoctorEmbeddings,
} from "./app/lib/cron";
import { transporter } from "./app/lib/nodemailer";
import { prisma } from "./app/lib/prisma";
import { redisClient } from "./app/lib/redis";
import {
  seedSuperAdmin,
  seedTesterAdmin,
  seedTesterDoctor,
} from "./app/utils/seed";

const PORT = Number(config.port) || 5000;

const main = async () => {
  try {
    await prisma.$connect();
    console.log("Connected to the database successfully.");

    redisClient.on("error", (error) => console.error("Redis error:", error.message));
    await redisClient.connect();
    console.log("Redis Connected Successfully.");

    // Mail is needed for OTPs and invoices, but a mail outage should not take the
    // whole API down; log it loudly instead.
    try {
      await transporter.verify();
      console.log("Nodemailer Connected Successfully.");
    } catch (error) {
      console.error("Nodemailer verification failed. Emails will not be sent:", error);
    }

    await seedSuperAdmin();
    await seedTesterAdmin();
    await seedTesterDoctor();

    deleteUnverifiedDoctors();
    reindexDoctorEmbeddings();

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Error starting the server:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
};

main();
