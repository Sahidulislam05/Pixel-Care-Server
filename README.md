# Pixel-Care — Backend API

REST API for **Pixel-Care**, an online doctor-consultation platform. Patients find a doctor, book a slot on a published schedule, pay with **bKash**, join a video call, and receive an invoice and a prescription by email. A **RAG-based AI assistant** helps patients pick the right doctor in plain language.

![Doctor-finding chatbot architecture](./Doctor-Finding%20Chatbot%20Architecture.png)

---

## Table of contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Getting started](#getting-started)
4. [Environment variables](#environment-variables)
5. [Scripts](#scripts)
6. [Project structure](#project-structure)
7. [API reference](#api-reference)
8. [Core flows](#core-flows)
9. [Testing](#testing)
10. [Deployment](#deployment)
11. [Troubleshooting](#troubleshooting)

---

## Features

| Area | What it does |
|---|---|
| **Authentication** | Email/password with email OTP verification, Google login (patients), JWT access + refresh tokens in httpOnly cookies, forgot/reset password, change/set password |
| **Roles** | `SUPER_ADMIN`, `ADMIN`, `DOCTOR`, `PATIENT`, with role-based middleware on every protected route |
| **Doctor onboarding** | Public application with resume upload → email OTP → admin approval → generated password emailed to the doctor |
| **Schedules** | One schedule per doctor per day, 3–8 hours, auto-split into 20-minute slots, draft → published, spec-based edit locks |
| **Booking & payments** | bKash tokenized checkout, verified payment execution, atomic slot allocation, serial numbers and joining times, PDF invoice by email |
| **Cancellation & refunds** | Patients cancel their own bookings, admins cancel any. Refund through bKash if cancelled more than 1 hour before start |
| **Consultations** | Doctor moves an appointment `CONFIRMED → ONGOING → COMPLETED`, then writes a prescription (PDF, stored on Cloudinary, emailed) |
| **AI assistant (RAG)** | Doctor profiles embedded into **pgvector**. Questions are condensed with chat history, matched by similarity, and answered by an LLM grounded only in real doctor data and today's open schedules |
| **Admin** | User management with search/filter/sort, block/unblock with role rules, create admins, review doctor applications, contact inbox |
| **Dashboards** | Analytics for admin, doctor and patient: totals plus chart data (appointments by status, 6-month trend of appointments and revenue) |
| **Public discovery** | Doctor listing with search, specialization/fee/experience filters, sorting and pagination. Doctor details and "available today" |
| **Contact** | Public contact form stored in the database |

---

## Tech stack

- **Runtime:** Node.js 20+, TypeScript, Express 5
- **Database:** PostgreSQL + **pgvector**, Prisma 7 (driver adapter `@prisma/adapter-pg`)
- **Cache / OTP / chat memory:** Redis
- **AI:** LangChain, OpenRouter (chat + embeddings), `@langchain/pgvector`
- **Payments:** bKash Tokenized Checkout
- **Files:** Cloudinary, Multer (in-memory, 5 MB limit)
- **Email:** Nodemailer (Gmail) + EJS templates, PDFKit for invoices and prescriptions
- **Validation:** Zod
- **Jobs:** node-cron
- **Tooling:** tsx, tsup, Biome

---

## Getting started

### Prerequisites

- Node.js **20 or newer**
- PostgreSQL with the **pgvector** extension (e.g. [Neon](https://neon.tech), which supports it out of the box)
- Redis (e.g. Redis Cloud free tier)
- Accounts for Cloudinary, OpenRouter, a Gmail App Password, and bKash sandbox credentials

### 1. Install

```bash
git clone <your-repo-url>
cd Pixel-Care-Backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in every value. See [Environment variables](#environment-variables).

### 3. Database

```bash
npx prisma migrate deploy   # apply all migrations (creates the vector extension too)
npx prisma generate         # generate the Prisma client into src/generated
```

### 4. Seed doctors and build the AI index (recommended)

```bash
npm run seed:doctors    # ~200 approved sample doctors across 34 specializations
npm run index:doctors   # embed every approved doctor into pgvector for the AI assistant
```

> The AI assistant can only recommend doctors that are indexed. New approvals and profile edits are indexed automatically, and a nightly cron re-indexes everything at 03:00.

### 5. Run

```bash
npm run dev
```

On startup the server connects to PostgreSQL, Redis and SMTP, and seeds the **Super Admin**, **Tester Admin** and **Tester Doctor** accounts from `.env` if they don't exist yet. Use those accounts as demo logins.

```bash
curl http://localhost:5000/
# {"success":true,"message":"Welcome to Pixel-care System Backend"}
```

---

## Environment variables

All variables are listed with comments in [`.env.example`](./.env.example).

| Variable | Required | Description |
|---|:---:|---|
| `NODE_ENV` | ✅ | `development` locally, `production` when deployed. Production enables secure cross-site cookies and hides 5xx error details |
| `PORT` | ✅ | API port (default `5000`) |
| `FRONTEND_URL` | ✅ | Exact frontend origin. Used for CORS and post-payment redirects |
| `BACKEND_URL` | | Public API URL (informational) |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | ✅ | Long random strings: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | ✅ | e.g. `1d`, `7d` |
| `BCRYPT_SALT_ROUNDS` | ✅ | e.g. `10` |
| `GOOGLE_CLIENT_ID` | ✅ | OAuth 2.0 Web client ID for Google login |
| `SUPER_ADMIN_*`, `TESTER_ADMIN_*`, `TESTER_DOCTOR_*` | ✅ | Name / email / password of accounts seeded at startup |
| `REDIS_USER`, `REDIS_PASSWORD`, `REDIS_HOST`, `REDIS_PORT` | ✅ | Redis connection |
| `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_SENDER` | ✅ | Gmail address, 16-character App Password, and "From" header |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | ✅ | Cloudinary credentials |
| `BKASH_BASE_URL`, `BKASH_USERNAME`, `BKASH_PASSWORD`, `BKASH_APP_KEY`, `BKASH_APP_SECRET` | ✅ | bKash tokenized checkout credentials (sandbox or live) |
| `BKASH_CALLBACK_URL` | ✅ | Public API base **including** `/api/v1`, e.g. `https://api.example.com/api/v1` |
| `OPENROUTER_API_KEY` | ✅ | OpenRouter key |
| `OPENROUTER_CHAT_MODEL` | ✅ | e.g. `openai/gpt-4o-mini` |
| `OPENROUTER_FALLBACK_CHAT_MODELS` | | Comma-separated fallback models |
| `OPENROUTER_EMBEDDING_MODEL` | ✅ | e.g. `openai/text-embedding-3-small`. Re-run `npm run index:doctors` if you change it |

> **Never commit `.env`.** If secrets were ever pushed to a public repository, rotate them.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start in watch mode (tsx) |
| `npm run build` | Bundle to `dist/` with tsup |
| `npm start` | Run the production build |
| `npm run seed:doctors` | Insert sample approved doctors (skips existing emails) |
| `npm run index:doctors` | Rebuild the doctor vector index |
| `npm run test:openrouter` | Smoke-test the OpenRouter configuration |
| `npm run lint:check` / `lint:fix` | Biome lint |
| `npm run format:check` / `format:fix` | Biome format |

---

## Project structure

```
Pixel-Care-Backend/
├── prisma/
│   ├── schema/              # one .prisma file per model (user, doctor, schedule, appointment, payment, chat, contact…)
│   └── migrations/
├── src/
│   ├── server.ts            # bootstrap: DB, Redis, SMTP, seeding, cron, listen
│   ├── app.ts               # express app, CORS, parsers, route mounting, error handling
│   ├── generated/prisma/    # generated Prisma client (git-ignored)
│   └── app/
│       ├── config/          # typed access to environment variables
│       ├── lib/             # prisma, redis, cloudinary, nodemailer, bkash, llm, vectorStore, cron, multer
│       ├── middleware/      # auth (JWT + RBAC), validateRequest (Zod), globalErrorHandler, notFound
│       ├── module/          # feature modules: route → controller → service (+ validation, interface)
│       │   ├── auth/  user/  doctor/  schedule/  appointment/
│       │   ├── payment/  prescription/  analytics/  chat/  contact/
│       ├── templates/       # EJS email templates
│       ├── scripts/         # indexDoctors, testOpenRouter
│       └── utils/           # AppError, catchAsync, sendResponse, jwt, seed, seedDoctors
├── .env.example
├── tsup.config.ts
└── prisma.config.ts
```

Each module follows the same layering: **route** (paths, auth, validation) → **controller** (HTTP in/out) → **service** (business rules and database access).

---

## API reference

Base URL: `http://localhost:5000/api/v1`

### Response format

```json
{ "success": true, "statusCode": 200, "message": "…", "data": {}, "meta": { "page": 1, "limit": 10, "total": 42, "totalPages": 5 } }
```

Errors return `success: false` with a human-readable `message`. 4xx messages are always shown. 5xx details are hidden in production.

### Authentication

Login responses set `accessToken` and `refreshToken` as **httpOnly cookies** and also return them in the body. Protected routes accept either the cookie or an `Authorization: Bearer <accessToken>` header. When the access token expires, call `POST /auth/refresh-token`.

List endpoints accept `page`, `limit`, `sortBy`, `sortOrder` (`asc` | `desc`) and `searchTerm`, where noted.

Legend: 🌐 public · 🧑 patient · 🩺 doctor · 🛡️ admin / super admin · 👤 any logged-in user

#### Auth — `/auth`

| Method | Path | Access | Description |
|---|---|:---:|---|
| POST | `/register` | 🌐 | Start patient registration, emails a 6-digit OTP `{ name, email, password, patient?: { contactNumber } }` |
| POST | `/verify-email` | 🌐 | Finish registration and log in `{ email, otp }` |
| POST | `/login` | 🌐 | `{ email, password }` |
| POST | `/google` | 🌐 | Patient Google login `{ idToken }` |
| POST | `/refresh-token` | 🌐 | New token pair from the refresh-token cookie |
| POST | `/logout` | 🌐 | Clear auth cookies |
| POST | `/forgot-password` | 🌐 | Email a reset OTP `{ email }` |
| POST | `/reset-password` | 🌐 | `{ email, otp, newPassword }` |
| GET | `/me` | 👤 | Current user with patient/doctor profile |
| POST | `/change-password` | 👤 | `{ currentPassword?, newPassword }`. `currentPassword` is optional only for Google accounts without a password (set password) |

Passwords need 8+ characters with upper case, lower case, a digit and a symbol.

#### Users — `/user`

| Method | Path | Access | Description |
|---|---|:---:|---|
| PATCH | `/me` | 👤 | Update profile `{ name?, contactNumber?, address? }` |
| PATCH | `/profile-image` | 👤 | `multipart/form-data`, field `profileImage` (image, ≤ 5 MB) |
| GET | `/` | 🛡️ | List users. Filters: `role`, `status`, `searchTerm` |
| PATCH | `/:userId/status` | 🛡️ | `{ status: "ACTIVE" \| "BLOCKED" }`. Only a super admin can act on admins |
| POST | `/create-admin` | 🛡️ | `{ name, email, personalEmail, role? }`. Password is emailed to `personalEmail`. Only a super admin can create a `SUPER_ADMIN` |

#### Doctors — `/doctor`

| Method | Path | Access | Description |
|---|---|:---:|---|
| GET | `/public/all-doctors` | 🌐 | Approved doctors. Filters: `searchTerm`, `specialization`, `minFee`, `maxFee`, `minExperience`. Sort: `createdAt`, `name`, `consultationFee`, `experienceYears` |
| GET | `/public/available-today` | 🌐 | Doctors with a bookable schedule today, with those schedules |
| GET | `/public/:doctorId` | 🌐 | Public doctor profile |
| POST | `/apply-as-doctor` | 🌐 | `multipart/form-data`: `data` (JSON `{ user: { name, email }, doctor: { specialization, licenseNumber, qualifications, experienceYears, address?, bio?, consultationFee?, contactNumber? } }`), `resume` (required), `additionalFiles` (≤ 10) |
| POST | `/apply-as-doctor/verify-email` | 🌐 | `{ email, otp }` |
| PATCH | `/update-my-profile` | 🩺 | `{ address?, bio?, consultationFee?, contactNumber? }` |
| GET | `/all-doctors` | 🛡️ | All doctors incl. applications. Filter `verificationStatus` |
| POST | `/approve-doctor` | 🛡️ | `{ doctorId, verificationStatus: "APPROVED" \| "REJECTED", rejectionReason? }` |

#### Schedules — `/schedule`

| Method | Path | Access | Description |
|---|---|:---:|---|
| POST | `/create-schedule` | 🩺 | `{ startDateTime, endDateTime, meetingLink }`, same day, 3–8 h, created as draft |
| GET | `/my-schedules` | 🩺 | Own schedules with bookings. Filter `status` |
| PATCH | `/update-schedule/:scheduleId` | 🩺 | Meet link always. Time only before the first booking. Date only while draft |
| PATCH | `/publish-schedule/:scheduleId` | 🩺 | Make visible to patients |
| DELETE | `/:scheduleId` | 🩺 | Soft delete (only without active bookings) |
| GET | `/todays-schedule?doctorId=` | 🌐 | A doctor's bookable schedules today |
| GET | `/all-schedules` | 🛡️ | All schedules |
| GET | `/:scheduleId` | 🩺 🛡️ | Schedule with appointments |

#### Appointments — `/appointment`

| Method | Path | Access | Description |
|---|---|:---:|---|
| POST | `/book-appointment` | 🧑 | `{ scheduleId }` → `{ appointmentId, paymentUrl }`. Redirect the browser to `paymentUrl` |
| POST | `/pay-appointment` | 🧑 | Retry payment for an own pending booking `{ appointmentId }` |
| GET | `/book-appointment/payment/callback` | bKash | Payment callback. Always redirects to the frontend |
| POST | `/cancel-appointment` | 🧑 🛡️ | `{ appointmentId }`. Refunds automatically when eligible |
| PATCH | `/update-status/:appointmentId` | 🩺 | `{ status: "ONGOING" \| "COMPLETED" }` |
| GET | `/my-appointments` | 🧑 | Filter `status` |
| GET | `/doctor-appointments` | 🩺 | Filter `status` |
| GET | `/all-appointments` | 🛡️ | Filters: `status`, `doctorId`, `patientId`, `doctorEmail`, `patientEmail` |
| GET | `/:appointmentId` | 👤 | Owner, assigned doctor, or admin |

#### Payments — `/payment`

| Method | Path | Access | Description |
|---|---|:---:|---|
| GET | `/my-payments` | 🧑 | Own payments |
| GET | `/all-payments` | 🛡️ | Filter `patientEmail` |
| GET | `/:paymentId` | 🧑 🛡️ | Single payment |

#### Prescriptions — `/prescription`

| Method | Path | Access | Description |
|---|---|:---:|---|
| POST | `/create-prescription` | 🩺 | `{ appointmentId, findings, medicines: [{ name, dosage, duration, instructions? }] }`. Completed appointments only, one per appointment |
| GET | `/:appointmentId` | 👤 | Prescription PDF URL (owner, doctor or admin) |

#### Analytics — `/analytics`

| Method | Path | Access | Returns |
|---|---|:---:|---|
| GET | `/admin-analytics` | 🛡️ | Doctor/patient/appointment totals, revenue, refunds, `charts` |
| GET | `/doctor-analytics` | 🩺 | Schedules, appointments by state, earnings, `charts` |
| GET | `/patient-analytics` | 🧑 | Appointments by state, amount spent, refunds, `charts` |

`charts` = `{ appointmentsByStatus: [{ status, count }], monthlyTrend: [{ month: "YYYY-MM", appointments, revenue }] }` (last 6 months). Ready for pie, bar and line charts.

#### AI assistant — `/chat`

| Method | Path | Access | Description |
|---|---|:---:|---|
| POST | `/` | 🌐 | `{ message, sessionId? }` → `{ sessionId, answer, doctors: [{ id, name, specialization, consultationFee, address }] }`. Understands locations ("cardiologist in Sylhet"). Send the returned `sessionId` back to continue the conversation (kept for 1 hour) |

#### Contact — `/contact`

| Method | Path | Access | Description |
|---|---|:---:|---|
| POST | `/` | 🌐 | `{ name, email, subject, message }` |
| GET | `/` | 🛡️ | Contact messages, newest first |

---

## Core flows

### Booking and payment

```
Patient                    API                                   bKash
  │  POST /book-appointment  │                                     │
  │─────────────────────────▶│  create PENDING appointment         │
  │                          │──── create payment ────────────────▶│
  │◀──── { paymentUrl } ─────│◀─── paymentID, bkashURL ────────────│
  │  pays on bKash page ────────────────────────────────────────────▶│
  │                          │◀── GET /payment/callback?status= ───│
  │                          │  execute payment, verify "Completed"│
  │                          │  in one transaction:                │
  │                          │   • take a slot (atomic, row-locked)│
  │                          │   • assign lowest free serial no.   │
  │                          │   • appointment → CONFIRMED         │
  │                          │   • payment → PAID                  │
  │                          │  email PDF invoice                  │
  │◀── 302 FRONTEND_URL/dashboard/my-appointments?status=success ──│
```

Redirect `status` values the frontend should handle: `success`, `failure`, `cancel`, `full` (the slot filled up during payment, so the money was refunded automatically), `error`.

- A callback is processed only once (idempotent), and a callback that bKash doesn't report as completed never confirms a booking.
- Joining time = schedule start + (serial − 1) × 20 minutes.

### Cancellation and refunds

| When | Result |
|---|---|
| Unpaid (pending) booking | Cancelled. Nothing to refund, slots untouched |
| Paid, more than 1 hour before the schedule starts | Cancelled, refunded through bKash, slot released |
| Paid, within 1 hour of start or later | Cancelled, no refund, slot released |
| Cancelled by an admin, paid | Cancelled and refunded |

The refund is requested **before** the appointment is changed. If bKash refuses, nothing is modified.

### Schedule rules

- One schedule per doctor per calendar day, start and end on the same day, between 3 and 8 hours, not in the past.
- Patients see a schedule only on its own day, only after it is published, only before it starts, and only while slots remain.

### AI assistant (RAG)

1. **Indexing:** each approved doctor becomes a text document (name, specialization, qualifications, experience, location, bio), embedded via OpenRouter and stored in the `doctor_embeddings` pgvector table. Re-indexing happens on approval/profile update and nightly.
2. **Condense:** for follow-up messages, the LLM rewrites the question into a standalone search query using the Redis-stored history.
3. **Retrieve:** cosine similarity search returns the top 4 doctors. Their live data and today's open schedules are loaded from PostgreSQL.
4. **Answer:** the LLM answers using only that context. The system prompt forbids inventing doctors or fees and forbids diagnosing or prescribing, and it directs emergencies to emergency services.

### Background jobs

| Job | Schedule | Purpose |
|---|---|---|
| Delete stale doctor applications | every 10 min | Removes doctor applications whose email was not verified within 1 hour |
| Re-index doctors | daily 03:00 | Keeps the AI assistant's vector index in sync |

---

## Testing

The API was verified end-to-end against a live PostgreSQL (Neon), Redis, Cloudinary, Gmail SMTP, bKash sandbox and OpenRouter setup. **137 of 137 checks passed**, covering:

- Registration with OTP, login, refresh, logout, change/forgot/reset password, token rejection for blocked users
- Profile update and image upload (including rejection of non-images and corrupt files)
- Public discovery: filters, sorting, pagination, safe fallbacks, field privacy
- Schedule rules: duration limits, same-day/past checks, one per day, publish, edit locks, delete rules
- Booking against the bKash sandbox, payment retry, cancel callback, and a forged "success" callback that is correctly **not** confirmed
- Cancellation (no refund or slot change for unpaid bookings), duplicate and re-booking guards
- Consultation lifecycle `ONGOING → COMPLETED` and prescription PDF creation, upload and email
- Doctor application → OTP → approval → generated-password login → automatic vector indexing
- AI assistant retrieval relevance and multi-turn memory
- Admin user management with role rules, admin creation, contact form, and all three analytics dashboards with chart data

Not covered automatically: completing a real payment on the bKash checkout page (this needs the sandbox wallet in a browser, so the paid path and refunds should be checked manually once), Google sign-in (needs a real Google ID token), and the cron schedules.

**Manual bKash sandbox check:** book an appointment, open the `paymentUrl`, pay with a bKash sandbox test wallet, and confirm you land on `/dashboard/my-appointments?status=success` and receive the invoice email.

---

## Deployment

Use a host that runs a long-lived Node process, such as **Render**, **Railway** or a VPS. **Serverless platforms such as Vercel are not suitable**, because the API relies on `app.listen`, in-process cron jobs and a persistent Redis connection.

**Render example**

| Setting | Value |
|---|---|
| Build command | `npm install && npx prisma generate && npm run build && npx prisma migrate deploy` |
| Start command | `npm start` |
| Environment | every variable from `.env.example`, with `NODE_ENV=production` |

Production checklist:

- `FRONTEND_URL` = the deployed frontend origin (no trailing slash).
- `BKASH_CALLBACK_URL` = `https://<your-api-domain>/api/v1`.
- In production, cookies are `Secure` + `SameSite=None`, so both apps must be served over **HTTPS**.
- Run `npm run index:doctors` once against the production database.
- Use fresh JWT secrets and a dedicated Gmail App Password.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Nodemailer verification failed` at startup | Use a Gmail **App Password** (Google Account → Security → 2-Step Verification → App passwords), not your normal password. The API still starts, but emails won't be sent |
| AI assistant says it can't find doctors | Run `npm run index:doctors`. Check that `OPENROUTER_*` is set (`npm run test:openrouter`) |
| Chat returns 503 "temporarily unavailable" | Usually an OpenRouter `429`: free models allow only 50 requests per day. Each chat message uses 2–3 requests. Add OpenRouter credits or use a paid model |
| `type "vector" does not exist` | Enable pgvector on your database. Neon has it, and the first embeddings migration runs `CREATE EXTENSION vector` |
| Cookies not stored by the browser in production | Both apps must use HTTPS and `FRONTEND_URL` must exactly match the frontend origin |
| bKash returns to an error page | `BKASH_CALLBACK_URL` must be publicly reachable and include `/api/v1` |
| `File upload rejected: …` | The file is corrupt or not a supported type. Limit is 5 MB per file |
