# Pixel-Care Project Audit

**তারিখ:** 2026-11-01  
**পরিধি:** `Project Requirements.md`-এর সঙ্গে backend source, routes, Prisma schema, startup/configuration, cron এবং available build/lint/test commands cross-check করা হয়েছে।  
**সীমা:** এটি source-level audit; live PostgreSQL, Redis, SMTP, Cloudinary বা bKash credentials দিয়ে integration/acceptance test করা হয়নি।

## Executive summary

Backend-এ authentication ছাড়াও doctor application, schedule, appointment, payment, prescription, analytics এবং profile-image modules আছে। তাই README-র “only authentication is working” বক্তব্য বর্তমান source-এর সঙ্গে মেলে না। তবে modules থাকা মানেই production-ready নয়: scheduling rules, payment concurrency/idempotency, cancellation, account management এবং startup configuration-এ blocking gaps রয়েছে।

`npm run build` সফল। `npm test` ব্যর্থ হয়েছে, কারণ script-টি সরাসরি “no test specified” বলে exit code 1 দেয়। `npm run lint:check` exit code 0 দিয়েছে, তবে 25 warnings ও 71 infos দেখিয়েছে। Database/payment/mail integrations চালিয়ে যাচাই করা সম্ভব হয়নি।

**সামগ্রিক সিদ্ধান্ত:** prototype/early integration-এর জন্য কিছু workflow আছে; Requirements অনুযায়ী professionally workable production system হিসেবে এখনো release করা উচিত নয়। বিশেষ করে payment/slot accounting এবং missing account-management flows ঠিক না করে launch করা ঝুঁকিপূর্ণ।

## Cron jobs এবং cron ছাড়া কাজ চালানোর সম্ভাবনা

| Job | Schedule | কাজ | প্রয়োজনীয়তা |
|---|---|---|---|
| Unverified doctor cleanup | প্রতি 10 মিনিটে (`*/10 * * * *`) | 1 ঘণ্টার বেশি পুরোনো, email-verified নয়, pending doctor user hard-delete করে | Core booking/consultation workflow-এর জন্য আবশ্যক নয়; Requirements-এ application expiry নির্দিষ্ট নেই |

Implementation: [`src/app/lib/cron.ts`](./src/app/lib/cron.ts#L7); startup-এ register হয় [`src/server.ts`](./src/server.ts#L30)।

**Cron বাদ দিলেও core product workable হতে পারে।** Doctor email OTP expiry (বর্তমানে 1 ঘণ্টা) Redis-এ নিয়ন্ত্রিত; cron মূলত abandoned/unverified application record পরিষ্কারের জন্য। Cron বাদ দিলে ওই records অনির্দিষ্টকাল থাকবে—এটি data-retention decision, core flow dependency নয়। যদি 1-hour application expiry business rule হিসেবে রাখতে চান, সেটি Requirements-এ লিখে cleanup-কে optional worker/managed scheduler-এ চালান। বর্তমান in-process cron multi-instance deployment-এ প্রতি server replica-তে duplicate চলবে; job-টি idempotent হলেও অপ্রয়োজনীয় duplicate work হবে।

Requirements-এ appointment status doctor নিজে `ongoing`/`completed` করেন; তাই এই transitions-এর জন্য cron দরকার নেই। বর্তমানে অন্য কোনো cron/scheduled job source-এ পাওয়া যায়নি।

## Findings — priority অনুযায়ী

### P0 — Release blocker

#### 1. Booking/payment callback-এ slot overbooking এবং duplicate processing সম্ভব

**Evidence:** [`src/app/module/appointment/appointment.service.ts`](./src/app/module/appointment/appointment.service.ts#L324) callback query-র `status === "success"` দেখে payment execute করে; appointment/payment state যাচাই করে one-time/idempotent transition নিশ্চিত না করেই serial number হিসাব ও slot decrement করে (প্রায় lines 343–393)। Booking শুরুতে slot availability শুধু read করে; payment success পর্যন্ত slot atomicভাবে reserve হয় না (প্রায় lines 105–180)।

**Impact:** একই slot-এর জন্য একাধিক pending payment শুরু হতে পারে। Concurrent বা পুনরায় আসা callback একই availability snapshot থেকে duplicate serial/appointment state তৈরি করতে পারে, slot count ভুল হতে পারে, এবং execute response-এ successful payment নিশ্চিত না করেও success branch-এ ঢোকার ঝুঁকি আছে। Callback-এ appointment/payment-এর সাথে payment ID/amount/currency/gateway success response মিলিয়ে যাচাইও স্পষ্ট নয়।

**করণীয়:** transaction-এ conditional/atomic slot reservation, payment state transition-এ idempotency guard, persisted payment ID + appointment ownership + amount/currency + bKash execute result যাচাই, এবং retry-safe invoice/email dispatch যোগ করুন। External API/email call দীর্ঘ DB transaction-এর মধ্যে রাখবেন না; outbox/retryable worker ব্যবহার করুন।

#### 2. Cancellation pending/unpaid appointment-এ slot count বাড়িয়ে capacity নষ্ট করতে পারে

**Evidence:** [`appointment.service.ts`](./src/app/module/appointment/appointment.service.ts#L550) appointment cancelled করার পর status আগে কী ছিল তা না দেখে `availableSlots` increment করে (প্রায় lines 559–564)। Slot decrement হয় payment callback-এ।

**Impact:** payment হওয়ার আগে PENDING appointment cancel করলে slot কখনো decrement-ই হয়নি, তবু increment হয়; `availableSlots > totalSlots` হতে পারে। Refund-এর সময়ও payment state ও gateway response সফল হয়েছে কি না নিশ্চিত করা প্রয়োজন। Admin cancellation route-এ অনুমোদিত হলেও service patient email দিয়ে appointment খোঁজে, তাই Admin/Super Admin দিয়ে cancellation কাজ করবে না (route: [`appointment.route.ts`](./src/app/module/appointment/appointment.route.ts:21); service: প্রায় lines 515–520)।

**করণীয়:** cancel operation status-aware ও atomic করুন; কেবল আগে reserved slot থাকলে একবারই release করুন। Refund কেবল PAID payment-এর জন্য, bKash refund success যাচাইয়ের পরে local state update করুন; Admin cancellation-এর authorization path আলাদা ও audited করুন।

#### 3. Startup default setup-এর সঙ্গে মেলে না এবং seed failure account delete করতে পারে

**Evidence:** [`src/server.ts`](./src/server.ts#L20) Redis ও SMTP-তে connect/verify বাধ্যতামূলক করে; এরপর তিনটি seed function সবসময় চালায় (lines 26–28)। [`seed.ts`](./src/app/utils/seed.ts#L25) Super Admin config না থাকলে error করে; catch block-এ configured email দিয়ে user delete করার চেষ্টা করে (প্রায় lines 49–53; একই pattern tester seeds-এও আছে)। [`.env.example`](./.env.example#L20)-এ Super Admin ও tester credentials ফাঁকা; README বলছে বাকি variables default-এ রাখা যায়।

**Impact:** example env পূরণ না করলেও app চালু হবে—এমন documentation misleading। Optional tester seed missing হলে production startup ব্যর্থ হতে পারে। Seed error-এর পর blind delete, seed creation/race failure-এ সংশ্লিষ্ট email-এর আগের account মুছে দেওয়ার ঝুঁকি সৃষ্টি করে।

**করণীয়:** startup env schema validation দিন; production-এ tester seeding বন্ধ/আলাদা command করুন; শুধু Super Admin bootstrap-কে explicit, idempotent, non-destructive করুন। Seed catch-এ account delete বাদ দিয়ে error propagate করুন। Local development setup-এর required/optional config স্পষ্ট করুন।

### P1 — High priority

#### 4. Schedule-এর 3–8 ঘণ্টা business rule enforce হয় না

**Evidence:** [`src/app/module/schedule/schedule.service.ts`](./src/app/module/schedule/schedule.service.ts#L62) duration থেকে 20 মিনিটের slot floor করে; validation কেবল অন্তত একটি 20-minute slot নিশ্চিত করে (lines 64–70)। Update path-এও একই logic (প্রায় lines 353–361)। Requirements §6.1 অনুযায়ী schedule 3–8 ঘণ্টার হতে হবে।

**Impact:** 20 মিনিট থেকে 3 ঘণ্টার কম বা 8 ঘণ্টার বেশি schedule তৈরি/publish করা যায়; remainder 20 মিনিটের গুণিতক না হলে schedule-এর শেষের সময় slot-এ গণনা হয় না।

**করণীয়:** create ও update—দুই পথেই 180–480 মিনিট এবং 20-minute slot alignment validate করুন; validation unit tests যোগ করুন।

#### 5. Schedule update-এ নিজের তারিখে update আটকে যায়; published-date lock নেই

**Evidence:** [`schedule.service.ts`](./src/app/module/schedule/schedule.service.ts#L330)-এ update-এর নতুন তারিখে schedule existence খোঁজে; নিজের বর্তমান schedule বাদ দেয় না, তাই একই date-এ সাধারণ update-ও conflict পায় (প্রায় lines 330–345)। Published schedule-এ booked appointment থাকলে সব update বন্ধ (line 292), অথচ Requirements §6.2-তে date publish-এর পর lock, কিন্তু time-range booking-এর আগে editable এবং meet link/status সবসময় editable।

**Impact:** সাধারণ same-day edit ব্যর্থ; published schedule-এর date ভুলভাবে বদলানো সম্ভব যখন booking নেই; booking হয়ে গেলে meet link/status-সহ অনুমোদিত edits-ও ব্যর্থ।

**করণীয়:** duplicate check-এ current schedule ID exclude করুন। Published state-এ date immutability আলাদা করে enforce করুন; booking না থাকলে time edits অনুমোদন, booking থাকলেও permitted fields update করা যাবে—শুধু slot/time reflow আটকান।

#### 6. Patient অন্যের pending appointment-এর payment শুরু করতে পারে

**Evidence:** [`appointment.service.ts`](./src/app/module/appointment/appointment.service.ts#L192) `payAppointment(payload, user)`-এ appointment ID দিয়ে record lookup করে (প্রায় lines 198–215), কিন্তু appointment patient-এর `user.userId`-এর সঙ্গে মেলে কি না যাচাই করে না। Route শুধু `Role.PATIENT` নিশ্চিত করে: [`appointment.route.ts`](./src/app/module/appointment/appointment.route.ts#L16)।

**Impact:** appointment ID জানা patient অন্য patient-এর pending booking-এ payment flow চালু করতে পারে; payer reference/receipt এবং appointment owner অসামঞ্জস্য হতে পারে।

**করণীয়:** lookup-এই patient profile/user ownership enforce করুন; payment initiation ও callback-এ একই persisted ownership যাচাই করুন।

#### 7. Required Admin/Patient management এবং password lifecycle অনুপস্থিত

**Evidence:** [`user.route.ts`](./src/app/module/user/user.route.ts#L9)-এ কেবল profile-image route। Auth routes-এ register/login/refresh/Google/forgot/reset আছে, কিন্তু change-password বা set-password নেই: [`auth.route.ts`](./src/app/module/auth/auth.route.ts#L58)। `needPasswordChange` field থাকলেও login flow-এ forced change gate নেই। `User` schema-তে Admin profile/management model-ও নেই: [`user.prisma`](./prisma/schema/user.prisma#L1)।

**Impact:** Requirements §§2.1, 3.5–3.6, 4 অনুযায়ী Admin/Super Admin তৈরি, role-অনুযায়ী block/unblock, Google-only patient-এর password set, logged-in password change এবং invite password বাধ্যতামূলকভাবে পরিবর্তন—এসব বাস্তবায়িত নয়। Doctor approval email-এ তৈরি password পাঠানো হলেও `needPasswordChange` কার্যকর হয় না।

**করণীয়:** Admin lifecycle/permission matrix ও personal-vs-organization email model বাস্তবায়ন; change/set-password endpoints, current-password/ownership validation, এবং `needPasswordChange` বাধ্যতামূলক gate যোগ করুন। Blocking/soft-delete authorization সব protected request-এ enforce করুন।

#### 8. Prescription-এর structured clinical data persist হয় না

**Evidence:** [`prescription.service.ts`](./src/app/module/prescription/prescription.service.ts#L75) findings/medicines PDF-এ লেখে; DB update-এ শুধু PDF URL/public ID রাখে (প্রায় lines 125–130)। Prisma appointment model-এ prescription URL আছে, findings/medicine record বা prescription model নেই: [`appointment.prisma`](./prisma/schema/appointment.prisma#L1)।

**Impact:** generated file ছাড়া prescription content query, correction/audit, export বা reliable reconstruction করা যায় না। Upload সফল কিন্তু DB/mail ব্যর্থ হলেও orphaned file বা অসম্পূর্ণ delivery হতে পারে।

**করণীয়:** prescription ও medicine items structured model-এ transactionally persist করুন; PDF/email-কে সেই record থেকে generate করুন, delivery retry/logging রাখুন।

#### 9. Soft-deleted/DELETED user authenticated request-এ আটকে যায় না

**Evidence:** [`checkAuth.ts`](./src/app/middleware/checkAuth.ts#L64)-এ user fetch করার পর শুধু BLOCKED status check হয় (line 71); `isDeleted` বা `status === DELETED` যাচাই নেই। Login flow-এ এই checks আছে, কিন্তু existing access token middleware দিয়ে চলতে পারে।

**Impact:** DELETED/soft-deleted account-এর পূর্বে issue করা access token expiry পর্যন্ত API access দিতে পারে।

**করণীয়:** middleware-এ `isDeleted`, DELETED status এবং ACTIVE status যাচাই; sensitive account changes-এ token/session revocation strategy যোগ করুন।

### P2 — Medium priority / quality gaps

#### 10. Credential casing/validation ও password configuration অসামঞ্জস্যপূর্ণ

**Evidence:** patient registration email normalize করে, কিন্তু doctor application DB lookup-এ `payload.user.email` raw ব্যবহার করে ( [`doctor.service.ts`](./src/app/module/doctor/doctor.service.ts#L25)); doctor flow-এ input password নেই এবং approval-এ random password দেওয়া হয়। Patient registration `bcrypt.hash(password, 8)` hardcode করে ( [`auth.service.ts`](./src/app/module/auth/auth.service.ts#L47)), অন্য code `BCRYPT_SALT_ROUNDS` ব্যবহার করে। `loginUser` unverified/pending/null-password state স্পষ্টভাবে reject না করে `bcrypt.compare`-এ যায় (প্রায় lines 222–253)।

**Impact:** case-insensitive email uniqueness conflict/duplicate-application UX হতে পারে; password policy/env inconsistent; unsupported doctor login path runtime error বা unclear auth failure দিতে পারে।

**করণীয়:** সব email normalize করে persist করুন; required verification/approval/password guards login-এর আগে দিন; validated `BCRYPT_SALT_ROUNDS` একভাবে ব্যবহার করুন।

#### 11. Timezone semantics নির্দিষ্ট নয়

**Evidence:** schedule/day boundary `isSameDay`, `startOfDay`, `new Date()` দিয়ে server timezone-এ নির্ধারিত: [`schedule.service.ts`](./src/app/module/schedule/schedule.service.ts#L25), lines 35–36, 468–490; invoice-এ `Date.toString()` ব্যবহার।

**Impact:** server UTC বা ভিন্ন timezone-এ deploy হলে Bangladesh calendar date, “today” visibility, cancellation cutoff এবং invoice time ভিন্ন হতে পারে।

**করণীয়:** business timezone (যেমন `Asia/Dhaka`) Requirements/config-এ নির্দিষ্ট করে all date queries, slot generation ও formatting একই timezone-aware policy-তে চালান।

#### 12. Payment admin filter ভুল query property পড়ে

**Evidence:** [`payment.service.ts`](./src/app/module/payment/payment.service.ts#L73) `query.patientEmail` থাকলে filter condition-এ `query.email` ব্যবহার করে (line 77)।

**Impact:** patient email দিয়ে admin payment search নির্ভরযোগ্য নয়।

**করণীয়:** সঠিক query field ব্যবহার ও query validation/test যোগ করুন।

#### 13. Test suite নেই; stale README ভুল operational নির্দেশনা দেয়

**Evidence:** `package.json` test script `echo ... && exit 1`; README lines 7–10 source-এর বর্তমান modules থাকা সত্ত্বেও বলে শুধু authentication implemented। README lines 202-204 error handler সবসময় 500 বলে, কিন্তু [`globalErrorHandler.ts`](./src/app/middleware/globalErrorHandler.ts#L15) computed status code-ই response-এ পাঠায়। README setup-এ config default-এ রাখা যায় বলা হলেও `.env.example`-এ database/JWT/Redis/SMTP/seed values ফাঁকা।

**Impact:** requirement coverage, local setup এবং API behavior সম্পর্কে developer/operator ভুল ধারণা পায়; regression detect করা যায় না।

**করণীয়:** API integration tests (registration/OTP, schedule rules, parallel booking, callback retry, cancellation/refund, RBAC) যোগ করুন; README-তে implemented/partial/missing status, real env requirements ও current error behavior আপডেট করুন।

## Requirement coverage snapshot

| Requirement area | অবস্থা | প্রধান gap |
|---|---|---|
| Patient credential registration + OTP + Google | আংশিক আছে | password config mismatch; required password lifecycle নেই |
| Forgot/reset password | আংশিক আছে | change-password/set-password নেই; token/session lifecycle অসম্পূর্ণ |
| Doctor application + email OTP + approval | আংশিক আছে | account management নেই; login gating স্পষ্ট নয়; resume handling/config flow পরীক্ষা বাকি |
| Admin/Super Admin create/block/manage | অনুপস্থিত | routes/services/profile model পাওয়া যায়নি |
| Schedule create/publish/edit | আংশিক আছে | 3–8h rule, update self-conflict, published-field lock ভুল |
| Today-only available doctor/schedule discovery | আংশিক আছে | server timezone-এর ওপর নির্ভরশীল |
| Paid booking + serial + invoice | আংশিক আছে | concurrency, callback idempotency/verification, slot accounting |
| Appointment status lifecycle | আংশিক আছে | doctor-driven transitions আছে; transaction/state consistency tests নেই |
| Cancel/refund | আংশিক আছে | pending cancellation slot corruption; Admin path service-এর সঙ্গে অসামঞ্জস্য |
| Prescription PDF/email | আংশিক আছে | structured prescription persistence নেই |
| Analytics/profile image | কিছু implementation আছে | requirements acceptance tests/operational checks অনুপস্থিত |

## Recommended implementation order

1. **Payment/slot integrity:** atomic slot reservation, callback verification/idempotency, cancel/refund state machine, ownership checks; parallel/retry tests।
2. **Schedule rules:** 3–8 hour bounds, slot alignment, update duplicate exclusion, published immutability/edit matrix, timezone policy।
3. **Account lifecycle:** Admin/Super Admin creation and block permissions; change/set password; forced-password-change; deleted-user request rejection।
4. **Startup reliability:** validated env contract, optional dev/test seeds, remove destructive seed cleanup, graceful shutdown/readiness checks।
5. **Persistence and operations:** structured prescription records, email/payment retry strategy, audit logs, migrations verification।
6. **Quality gate/docs:** test suite, API acceptance tests, README + `.env.example` corrected, lint warning cleanup।

## Audit validation

- `npm run build` — **PASS**
- `npm run lint:check` — **exit 0**, 25 warnings, 71 infos
- `npm test` — **FAIL (configured placeholder; no tests run)**
- External integration/DB migrations — **not executed** (credentials/services not supplied)
