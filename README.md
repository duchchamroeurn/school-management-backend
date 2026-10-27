# School Management Backend

REST API for managing a single school: staff, students, academic years, grades, subjects, class sections, and yearly enrollments, with role-based access control.

Built with **Node.js**, **Express 5**, **TypeScript**, **Prisma 7**, and **PostgreSQL**.

## Features

- **Authentication**: JWT access tokens and bcrypt password hashing. New or reset accounts must change their password on first login.
- **Role-based access control**: users hold roles, and roles grant permissions through explicit junction tables. Every route checks a specific permission.
- **Separate auth and profiles**: a `User` login is linked to a `StaffProfile` or a `StudentProfile`. A student login holds only the `Student` role.
- **Bilingual names**: records carry both a `khmerName` and a `latinName`.
- **Academic structure**: academic years, grades, subjects mapped to grades, class sections with homeroom teachers, and yearly enrollments.
- **Data import**: bulk import of students and staff from JSON files, validated with the same rules as the API.
- **Student registry (សៀវភៅបញ្ជីឈ្មោះសិស្ស)**: each student has a 4x4 photo, a birth certificate scan, the parents, and the place of birth and address as villages of the official gazetteer (ភូមិ › ឃុំ/សង្កាត់ › ស្រុក/ក្រុង/ខណ្ឌ › ខេត្ត/រាជធានី).

## Project structure

```
prisma/
  schema.prisma          # Database schema
prisma7.config.ts        # Prisma config (schema path, seed command, datasource)
src/
  app.ts                 # Express app and route mounting
  server.ts              # HTTP server entrypoint
  constants/             # Permission and role definitions
  controllers/           # Request/response handling
  services/              # Business logic and database access
  routes/                # Route definitions and permission guards
  middlewares/           # authenticate, requirePermission, errorHandler
  lib/prisma.ts          # Prisma client (pg driver adapter)
  utils/                 # JWT, passwords, validation, seed and import scripts
postman/                 # Postman collection and local environment
```

## Getting started

### Prerequisites

- Node.js 22+
- PostgreSQL 17 (or use Docker, see below)

### 1. Install dependencies

```sh
npm install
```

### 2. Configure environment

Copy the example file, then set a real `JWT_SECRET` and your frontend's address in `CORS_ORIGINS`:

```sh
cp .env.example .env
npm run jwt:secret        # writes a random JWT_SECRET into .env
```

`npm run jwt:secret` refuses to replace a secret that's already set, because that logs everyone out. Add `-- --force` to replace it anyway, or `-- --print` to only print a new secret.

[.env.example](.env.example) documents every setting. The API checks them at startup and exits with a list of problems if a required value is missing or invalid. It also exits if it can't connect to `DATABASE_URL`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | | PostgreSQL connection string (`postgresql://…`) |
| `JWT_SECRET` | Yes | | Secret used to sign access tokens: at least 32 random characters |
| `CORS_ORIGINS` | Yes | | Comma-separated frontend origins allowed to call the API from a browser, e.g. `https://school.example.com,http://localhost:5173` |
| `JWT_EXPIRES_IN` | No | `8h` | Access token lifetime, with a unit (`30m`, `8h`, `7d`) |
| `PORT` | No | `3000` | API port |
| `NODE_ENV` | No | | Set to `production` to block the demo scripts |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn` or `error` |
| `LOG_FORMAT` | No | `json` | `json` (one object per line) or `pretty` (readable, for development) |
| `LOGIN_MAX_FAILURES` | No | `5` | Failed logins in a row before a username is locked |
| `LOGIN_LOCK_MINUTES` | No | `15` | How long a locked username stays locked |
| `LOGIN_IP_MAX_FAILURES` | No | `30` | Failed logins from one IP before that IP is blocked |
| `LOGIN_IP_WINDOW_MINUTES` | No | `15` | Window for `LOGIN_IP_MAX_FAILURES` |
| `SCHOOL_LEVEL` | No | `COMBINED` | `LOWER_SECONDARY`, `UPPER_SECONDARY` or `COMBINED`. Used on first install only |
| `SCHOOL_KHMER_NAME` / `SCHOOL_LATIN_NAME` | No | | School name. Used on first install only |
| `SEED_ADMIN_USERNAME` | No | `admin` | Username of the seeded root admin |
| `SEED_ADMIN_PASSWORD` | No | `Admin@123!` | Initial password of the seeded root admin |
| `DEMO_PASSWORD` | No | `Demo@1234` | Password for demo accounts (`db:seed:demo`) |

### 3. Set up the database

```sh
npx prisma generate      # Generate the Prisma client
npm run db:push          # Sync the schema to the database
npm run db:seed          # Seed roles, permissions, grades, subjects and the root admin
```

### 4. Run the API

```sh
npm run dev              # Development with watch mode
```

For production:

```sh
npm run build
npm start
```

The API runs at `http://localhost:3000/api/v1`. Check it with:

```sh
curl http://localhost:3000/api/v1/health
```

The health check returns `200` only when the API can serve requests. It returns `503 SERVICE_UNAVAILABLE` if the database doesn't answer within 3 seconds, or while the server is shutting down.

**Shutdown:** on `SIGTERM` (for example `docker compose stop`) or `Ctrl+C`, the API stops accepting connections, lets running requests finish, then closes the database connections. If requests are still running after 8 seconds, it exits anyway.

**Logs:** every request is logged as one line with method, path, status, duration, IP and the signed-in user. Query strings are left out because searches contain names, and request bodies are never logged. Each response has an `X-Request-Id` header, and log lines written during that request carry the same `requestId`, so an error a user reports can be found in the logs. If the frontend or a proxy sends its own `X-Request-Id`, that value is used. Errors and `4xx`/`5xx` requests go to stderr; everything else goes to stdout.

### First login

Log in as `admin` with the `SEED_ADMIN_PASSWORD` (default `Admin@123!`). You must change the password through `POST /api/v1/auth/change-password` before other endpoints will accept the token.

Failed logins are throttled. After `LOGIN_MAX_FAILURES` wrong passwords in a row, the username is locked for `LOGIN_LOCK_MINUTES`, and even the correct password is refused until the lock ends. An IP that reaches `LOGIN_IP_MAX_FAILURES` failures is also blocked. Both cases return `429` with a `Retry-After` header. The counters are kept in memory, so restarting the API clears them.

## Running with Docker

```sh
cp .env.example .env     # then set JWT_SECRET, CORS_ORIGINS and S3_SECRET_KEY
docker compose up --build
```

This starts six services:

- **db**: PostgreSQL 17 on port `5432`, stored in the `pgdata` volume
- **migrate**: a one-off job that pushes the schema and seeds default data, then exits
- **api**: the API on port `3000` (override with `API_PORT`), started once `migrate` succeeds
- **minio**: object storage for uploaded files (student photos, birth certificate scans), stored in the `miniodata` volume. Its S3 API (`9000`) and web console (`9001`) are published on `127.0.0.1` only. The login is `S3_ACCESS_KEY` / `S3_SECRET_KEY`.
- **backup**: nightly database backups (see [Backups](#backups))
- **files-backup**: nightly copy of the uploaded files (see [Backups](#backups))

The web app has its own container in the frontend repository (school-management-system). It joins this Compose
network and serves the app and the API on one address. Behind it, set `TRUST_PROXY=1` here, so login throttling and the
audit log see each user's own IP address instead of the container's. Then keep `API_PORT` off the network, for example
`API_PORT=127.0.0.1:3000`, so nobody can reach the API directly and fake an address.

MinIO Inc. stopped publishing Docker images in 2025. Compose uses a maintained community build of the same server (`pgsty/minio`). To use another image, set `MINIO_IMAGE`.

The containers read all settings from `.env`. Compose builds `DATABASE_URL` from `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`, so the `DATABASE_URL` in `.env` is only used outside Docker.

### Backups

The `backup` service runs `pg_dump` when it starts and every night at `BACKUP_TIME` (default `02:00`, in `TZ`, default `Asia/Phnom_Penh`). Each dump is checked before it counts. Dumps older than `BACKUP_KEEP_DAYS` (default 14) are deleted, but only after a successful backup, so a failing backup never removes the last good copies.

Dumps are written to `BACKUP_DIR` on the host (default `./backups`), as files like `school_management_2026-10-20_020000.dump`.

> **Put `BACKUP_DIR` on a different disk than the database**, such as a second drive, a USB disk or a mounted NAS, for example `BACKUP_DIR=/mnt/backup-disk/school`. If the backups sit on the same disk, one disk failure loses both. For extra safety, copy the folder off-site now and then.

Check that backups are running:

```sh
docker compose ps backup        # "healthy" means a good backup in the last 25 hours
docker compose logs backup      # one line per backup, plus any errors
```

Take a backup now, for example before an upgrade:

```sh
docker compose exec backup /bin/sh /backup.sh once
```

Restore a backup. This replaces the current data:

```sh
docker compose stop api
docker compose exec -T db pg_restore --clean --if-exists --no-owner \
  -U school -d school_management < backups/school_management_2026-10-20_020000.dump
docker compose start api
```

If you changed `POSTGRES_USER` or `POSTGRES_DB`, use those values for `-U` and `-d`.

#### Uploaded files

The `files-backup` service copies the MinIO bucket to `BACKUP_DIR/files/<bucket>` when it starts and every night at `BACKUP_TIME`. The copies are plain files, one per upload.

- **Nothing is ever overwritten:** each upload gets a new name, so a stored file never changes.
- **Deletions are kept:** files deleted from the bucket stay in the copy. Every file that an older database dump refers to is therefore still there when you restore that dump.

Check the service, or copy now:

```sh
docker compose ps files-backup                               # "healthy" means a good copy in the last 25 hours
docker compose exec files-backup /bin/sh /files-backup.sh once
```

Restore the files, after restoring the database:

```sh
docker compose run --rm --entrypoint sh files-backup -c \
  'mc alias set school "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" && mc mirror /backups/files/$S3_BUCKET school/$S3_BUCKET'
```

## Testing

```sh
npm test            # run the test suite once
npm run test:watch  # re-run on every change
npm run typecheck   # type-check the code and the tests
```

The tests ([`tests/`](tests)) call the real API with Supertest against a separate database, `school_management_test`, on the same PostgreSQL server. So the Docker `db` service, or your local PostgreSQL, must be running.

Each run starts clean:
1. The test database is dropped and created again.
2. The schema is pushed to it.
3. The real seed runs.
4. Three academic years are added: 2025-2026 completed, 2026-2027 active and 2027-2028 upcoming.

The suite refuses to run against any database whose name doesn't end in `_test`, so it can never touch your development data. To use another server, set `TEST_DATABASE_URL`.

What the tests cover:
- **Login protection:** lockout, and that unknown usernames behave the same.
- **Password change:** it revokes older tokens.
- **Score entry:** the teacher's subject and class scope, component rules, the deadline, and locked periods.
- **Grading rules:** they freeze once scored.
- **Results:** ranking with ties, the A–F scale, missing scores, and remarks surviving recalculation.
- **Promotion:** all-or-nothing, dry run, repeating and excluded students, top-grade graduation.
- **Audit log:** who, what and when, changed fields only, no passwords or hashes.
- **Guardians:** one primary contact, shared between siblings.

Each test builds its own uniquely named data with the helpers in [`tests/helpers.ts`](tests/helpers.ts), so tests don't depend on each other.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the API with watch mode (`tsx`) |
| `npm test` | Run the test suite (needs PostgreSQL and MinIO running: `docker compose up -d db minio`) |
| `npm run typecheck` | Type-check the code and the tests |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled API |
| `npm run db:push` | Sync `prisma/schema.prisma` to the database |
| `npm run db:studio` | Open Prisma Studio |
| `npm run jwt:secret` | Write a random `JWT_SECRET` into `.env` |
| `npm run db:seed` | Seed reference data and the root admin |
| `npm run gazetteer:download` | Download the official gazetteer to `data/gazetteer.json` |
| `npm run db:seed:gazetteer` | Import or update the gazetteer from `data/gazetteer.json` |
| `npm run db:seed:students` | Import students from `data/students.json` |
| `npm run db:seed:staff` | Import staff from `data/staff.json` |
| `npm run db:seed:demo` | Build a demo school on top of the imported data |
| `npm run db:reset:demo` | Remove the demo data and rebuild it |

### Gazetteer (provinces, districts, communes, villages)

Student addresses point to villages of the official NCDD gazetteer: 25 provinces, about 210 districts, 1,652 communes and 14,500 villages. Install it once, and re-run both commands when the official gazetteer changes:

```sh
npm run gazetteer:download     # from the open Pumi dataset (MIT licence), writes data/gazetteer.json
npm run db:seed:gazetteer      # adds new places and renames changed ones; --dry-run to preview
```

The server itself never calls the internet. Places that are no longer in the file are kept, because students may still live there, and the import lists them.

### Importing students and staff

The import scripts read JSON files from `data/`. That folder holds real personal data, so it is **git-ignored and never committed**.

```sh
npm run db:seed:students -- --dry-run            # Validate only
npm run db:seed:students                         # Validate and import
npm run db:seed:staff -- path/to/staff.json      # Import from a custom file
```

A student entry also needs `birthPlaceVillageCode` and `addressVillageCode`, which are 8-digit gazetteer codes. It also needs the paths of its `photo` and `birthCertificateScan` files, relative to the JSON file:

```json
{
  "birthCertificateNo": "1001/2013", "khmerName": "សុខ ចាន់ថា", "latinName": "Sok Chantha",
  "dateOfBirth": "2013-04-14", "gender": "F", "primarySchoolOrigin": "Wat Phnom Primary School",
  "fatherName": "សុខ ចាន់", "fatherOccupation": "កសិករ", "isFatherDeceased": false,
  "motherName": "ម៉ៅ ស្រីនី", "motherOccupation": "លក់ដូរ", "isMotherDeceased": false,
  "birthPlaceVillageCode": "01020101", "addressVillageCode": "12010101", "addressHouseNo": "12B", "addressStreet": "271",
  "photo": "photos/1001-2013.jpg", "birthCertificateScan": "birth-certificates/1001-2013.pdf"
}
```

The demo installer passes `--demo-placeholders`. With it, entries without documents get generated placeholder documents, and entries without village codes get random gazetteer villages. This option is refused when `NODE_ENV=production`.

Every entry is validated first. If any entry is invalid, nothing is imported. Entries that are already registered (matched by birth certificate number for students, national ID for staff) are skipped, so imports are safe to re-run.

### Demo data

`npm run db:seed:demo` builds a full demo school for testing. It needs `db:seed`, at least 100 imported students and at least 24 imported staff. It refuses to run when `NODE_ENV=production`.

## API overview

All routes are prefixed with `/api/v1`. Except for `/health` and `/auth/login`, every request needs an `Authorization: Bearer <token>` header. Request and response bodies use camelCase.

| Resource | Endpoints |
| --- | --- |
| Health | `GET /health` |
| Auth | `POST /auth/login`, `POST /auth/change-password`, `GET /auth/me` |
| Me (own data) | `GET /me/profile`, `GET /me/homeroom?academicYear=` |
| Dashboard | `GET /dashboard?academicYearId=` |
| Teacher | `GET /teacher/my-classes?academicYear=` |
| Audit log | `GET /audit-logs` |
| Assessment periods | CRUD on `/assessment-periods`, plus `POST /:id/lock`, `POST /:id/unlock`, `PUT/DELETE /:id/subjects/:subjectId` and `POST /:id/copy-rules` |
| Scores | `GET /scores/subject-sheet`, `POST /scores/subject`, `POST /scores/results/calculate`, `PATCH /scores/results/remarks` |
| Reports | `GET /reports/class-list/:classSectionId`, `GET /reports/gender-statistics`, `GET /reports/report-cards/:classSectionId` |
| Users | `GET /users`, `GET /users/:id`, `POST /users`, `PUT /users/:id/roles`, `PATCH /users/:id/status`, `POST /users/:id/reset-password`, `DELETE /users/:id` |
| Roles | `GET /roles`, `GET /roles/:id` |
| Staff | CRUD on `/staff`, plus `POST /staff/assign-homeroom` |
| Students | CRUD on `/students`, plus `GET/POST /students/:id/guardians` and `PATCH/DELETE /students/:id/guardians/:guardianId` |
| Guardians | CRUD on `/guardians` (`GET /guardians?search=` matches names and phone numbers) |
| Academic years | CRUD on `/academic-years` |
| Grades | CRUD on `/grades` |
| Subjects | CRUD on `/subjects`, plus `POST /subjects/:id/grades` and `DELETE /subjects/:id/grades/:gradeId` |
| Class sections | CRUD on `/class-sections`, plus `GET /class-sections/:id/roster` and `POST /class-sections/:id/promote` |
| Timetable | `GET /timetable/classes/:classSectionId`, `PUT/DELETE /timetable/classes/:classSectionId/slots/:timeSlotId`, `GET /timetable/teachers/:staffId`, `GET /timetable/me`, `GET /timetable/quotas`, CRUD on `/timetable/time-slots` |
| Rooms | CRUD on `/rooms` |
| Announcements | `GET /announcements/feed`, `GET /announcements/feed/unread-count`, `POST /announcements/feed/read-all`, `POST /announcements/:id/read`, CRUD on `/announcements` |
| School calendar | `GET /school-calendar?from=&to=`, `GET/PUT /school-calendar/week`, `GET/POST /school-calendar/events`, `PATCH/DELETE /school-calendar/events/:id` |
| Subject teachers | `GET /assignments/class/:classSectionId`, plus CRUD on `/assignments/subject-teacher` (`PATCH` takes `{ staffId }` to hand the subject to another teacher) |
| Enrollments | CRUD on `/enrollments` |

"CRUD" means `GET /`, `GET /:id`, `POST /`, `PATCH /:id` and `DELETE /:id`.

### Own data (`/me`)

These endpoints always use the signed-in login's own profile, never an id from the request, so a user can only see their own records.

- `GET /me/profile` (`VIEW_OWN_PROFILE`): returns `{ profileType, profile }`.
  - For a student login, this is their student record with enrollment history, including each year's class and homeroom teacher.
  - For a staff login, it's their staff record with homeroom history.
  - Returns `404 PROFILE_NOT_FOUND` if the login has no profile.
- `GET /me/homeroom` (`VIEW_OWN_HOMEROOM`): the roster of the class the signed-in teacher is homeroom teacher of, in the same format as `GET /class-sections/:id/roster`.
  - Defaults to the ACTIVE academic year. Pass `?academicYear=2025-2026` for another year.
  - Returns `404 NO_HOMEROOM_CLASS` if they have no homeroom class that year.

### Dashboard

`GET /dashboard` returns a summary for the signed-in user, covering the ACTIVE academic year by default or `?academicYearId=`. Each section appears only if the user holds the permission behind it, so built-in and custom roles get exactly what their permissions allow. Sections return numbers and ids only, and the frontend supplies the labels.

| Section | Shown with | What it holds |
| --- | --- | --- |
| `enrollment` | `CREATE_ENROLLMENT` | Active students (total and girls) by grade; new admissions, promoted, repeating; dropouts and graduates; students not placed in a class this year |
| `capacity` | `CREATE_ENROLLMENT` | Seats used and left per class, and full classes |
| `attendanceToday` | `VIEW_ANY_ATTENDANCE` | Today's daily attendance across the school, the attendance rate, and classes not marked yet |
| `scoreEntry` | `MANAGE_ASSESSMENT_RULES` or `ENTER_ANY_SCORES` | For each open period: scores entered vs expected, the deadline, and classes with results |
| `staffing` | `UPDATE_CLASS_SECTION` or `UPDATE_STAFF` | Classes without a homeroom teacher, and subjects without a teacher in each class |
| `dataQuality` | `UPDATE_STUDENT` | Active students with no guardian, or no guardian phone |
| `pendingLeave` | `REVIEW_LEAVE_REQUEST` | Leave requests waiting for a decision |
| `security` | `LIST_AUDIT_LOGS` | Last 24 h: failed logins, account locks, logins from outside the school network; user counts (with `LIST_USERS`) |
| `myScoreEntry` | `ENTER_SCORES` + assignments | For each of the teacher's subjects and classes, per open period: scores entered and remaining |
| `myHomeroom` | `VIEW_OWN_HOMEROOM` + a homeroom class | Students, today's attendance, frequent absentees (≥ 3 unexcused absences in 30 days), pending leave, and which periods have results |
| `myStudent` | `VIEW_OWN_PROFILE` + a student login | Class and homeroom teacher, latest result, this month's attendance, recent leave requests |

What each role sees by default:
- **Principal:** every school-wide section.
- **Registrar:** `enrollment`, `capacity`, `attendanceToday` and `dataQuality`.
- **Teacher:** `myHomeroom` and `myScoreEntry`.
- **Student:** `myStudent`.
- **System Admin:** everything.

### Student registration

`POST /students` takes `multipart/form-data`: the student's details as text fields, plus two files.

- **`photo`:** a JPEG or PNG of at most 5 MB, roughly square (4x4), and at least 300 px. It is cropped and stored as a 472×472 px JPEG, which is 4 cm at 300 dpi. Metadata such as GPS is removed.
- **`birthCertificateScan`:** a JPEG, PNG or PDF of at most 10 MB.

These fields are required: `birthCertificateNo`, `khmerName`, `latinName`, `dateOfBirth`, `gender`, `birthPlaceVillageCode` and `addressVillageCode`.

These fields are optional:

- `primarySchoolOrigin`
- `addressHouseNo` and `addressStreet`
- `fatherName`, `fatherOccupation` and `isFatherDeceased`
- `motherName`, `motherOccupation` and `isMotherDeceased`

Write the booleans as `"true"` or `"false"`.

Responses write out `birthPlace` and `address` in full, in Khmer and in Latin script, for example `ភូមិអូរធំ ឃុំបន្ទាយនាង ស្រុកមង្គលបូរី ខេត្តបន្ទាយមានជ័យ`.

- **Changing details:** `PATCH /students/:id` takes JSON.
- **Replacing a document:** use `PUT /students/:id/photo` or `PUT /students/:id/birth-certificate-scan`. Replacements are audited.
- **Viewing a document:** use `GET` on the same paths. It needs `VIEW_STUDENT`, because the files are only served through the API.
- **Showing the photo in a browser:** fetch it with the bearer token and display it as a blob URL.

`GET /locations/...` serves the gazetteer for cascading address pickers, to any signed-in user: provinces, and then the districts, communes and villages under each one, plus a village search by name.

### Guardians

A guardian (អាណាព្យាបាល) is stored once and linked to each of their children, so siblings share the record, and a new phone number is entered once.
- **Relationship:** each link stores how the guardian is related to that student: `FATHER`, `MOTHER`, `GRANDPARENT`, `SIBLING`, `UNCLE_AUNT` or `OTHER`.
- **Primary contact:** each link also says whether this guardian is that student's primary contact. There is exactly one per student: the first guardian added becomes primary, making another primary moves the flag, and unlinking the primary passes it on to the next guardian.

```jsonc
// Add a new guardian to a student
POST /students/:id/guardians
{ "relationship": "MOTHER", "guardian": { "khmerName": "សុខ ចាន់ធី", "latinName": "Sok Chanthy", "phone": "012 345 678", "occupation": "កសិករ" } }

// Link an existing guardian (e.g. found with GET /guardians?search=012345) to a sibling
POST /students/:id/guardians
{ "relationship": "MOTHER", "guardianId": "…", "isPrimaryContact": true }
```

- **Phone numbers** are normalised to the local format (`+855 12 345 678` → `012345678`).
- **Access:** guardians appear in `GET /students/:id`, and students see their own through `/me/profile`. Anyone with `VIEW_STUDENT` can read them, which includes teachers, so they can contact families. Managing them needs `UPDATE_STUDENT`.
- **Deleting:** a guardian can only be deleted once no student is linked to them.
- **Audit:** every change is recorded in the audit log.

### End-of-year promotion

`POST /class-sections/:id/promote` moves a whole class into the next academic year. It needs `CREATE_ENROLLMENT` and `UPDATE_STUDENT`, which Registrar, Principal and System Admin hold.

```jsonc
{
  "promotedClassSectionId": "…",   // a class in the next grade, in the next year
  "repeatingClassSectionId": "…",  // a class in the same grade, in the next year (needed if anyone repeats)
  "repeatingStudentIds": ["…"],    // these students are enrolled as REPEATING
  "excludedStudentIds": ["…"],     // these students are left alone (e.g. moving school)
  "dryRun": true                   // check everything and show the result, but change nothing
}
```

- **Who moves:** every active student in the class is enrolled as `PROMOTED`, except those listed as repeating or excluded.
- **Skipped automatically:** students who dropped out or already graduated, and students already enrolled in the target year, for example placed by hand. They're listed under `skipped`.
- **Top grade:** the school's top grade has no next grade, so promoted students are marked `GRADUATED` instead, and `promotedClassSectionId` isn't sent. That's grade 9 for a lower-secondary school and grade 12 otherwise.
- **All or nothing:** the whole class moves in one transaction. If any student can't be placed, for example because a target class is full, nothing changes. Each student goes through the same checks as a single enrollment, including capacity.
- **Splitting a class:** to divide a class across two target classes, run it twice and exclude a different half of the students each time.
- **Dry run:** use `dryRun: true` to preview the result first; it returns `200`. A real run returns `201`.
- **Audit:** each new enrollment and graduation is audited, plus one `CLASS_PROMOTED` entry for the class with the counts.

### Timetable

Classes study in one of two half-day shifts (វេន): morning (ព្រឹក) or afternoon (រសៀល).
- **Shift and room:** set on the class with `PATCH /class-sections/:id { shift, roomId }`. The default is morning.
- **Shift lock:** once a class has lessons, its shift can't change until they're cleared.

**Rooms:** create them with `POST /rooms`. Each class has a home room, and two classes share a room only if they're in different shifts of the same year. This is how a school fits more classes than it has rooms.

**Bell schedule:** the school's time slots, one per day, shift and period. The seed creates a default if there is none:
- 5 periods of 45 minutes per shift, with a 15-minute break after period 3.
- Morning Monday–Saturday, 07:00–11:00; afternoon Monday–Friday, 13:00–17:00. Saturday afternoon has no slots.
- That gives morning classes 30 lessons a week and afternoon classes 25.
- Change times or add slots through `/timetable/time-slots`. A slot that has lessons can still change its times, but not its day, shift or period.

**MoEYS quotas:** set a subject's lessons per week in a grade with `PATCH /subjects/:id/grades/:gradeId { weeklyPeriods }`, for example Mathematics 5 or Morality 1.

**Placing lessons:** `PUT /timetable/classes/:classSectionId/slots/:timeSlotId { subjectId }` puts a subject in a slot, replacing any lesson there. `DELETE` frees the slot. Both need `MANAGE_TIMETABLE`, which Principal and System Admin hold. Every placement is checked:
- **Shift:** the slot must be in the class's shift (`400 WRONG_SHIFT`).
- **Grade:** the subject must be taught in the class's grade.
- **Quota:** the subject can't go over its weekly quota (`409 QUOTA_EXCEEDED`).
- **Rule 1, teachers:** a teacher teaches one class at a time (`409 TEACHER_CLASH`, naming the other class).
- **Rule 2, classes:** a class has one lesson per slot. Placing a lesson again replaces the old one.

Both rules are also database constraints, so they hold even if two people edit at once.

**Teachers on lessons:** a lesson's teacher is the subject's assigned teacher in that class.
- **Assigning or reassigning** a subject updates its lessons. It's refused if the new teacher would clash.
- **Removing an assignment** keeps the lessons, without a teacher.

**Reading timetables:**
- `GET /timetable/classes/:classSectionId`: the class's week (every slot, with lesson or free), each subject's quota status (`MET`, `MISSING`, `OVER` or `NO_QUOTA`), and whether the quotas fit in the shift.
- `GET /timetable/teachers/:staffId`: a teacher's week across both shifts.
- `GET /timetable/me`: the signed-in teacher's lessons, or a student's class week.
- `GET /timetable/quotas`: every class with the lessons still missing to meet its quotas.

### School calendar

Anyone signed in can read the calendar. Changing it needs `MANAGE_SCHOOL_CALENDAR`.

**The school week:** `GET /school-calendar/week` returns the seven weekdays (1 = Monday … 7 = Sunday), each with whether the morning and afternoon shifts are taught. It starts as Monday–Saturday mornings and Monday–Friday afternoons. `PUT /school-calendar/week` takes `{ weekdays: [{ dayOfWeek, morning, afternoon }] }` with all seven days.

**Calendar entries** (`/school-calendar/events`) run from `startDate` to `endDate`, inclusive, and cover one shift (`shift`) or the whole day (no shift):

| `type` | Effect |
| --- | --- |
| `PUBLIC_HOLIDAY` | Closes the school. With `recursYearly: true`, repeats on the same dates every year from its first year on (for fixed-date holidays such as 9 November; lunar holidays are entered each year) |
| `SCHOOL_BREAK` | Closes the school |
| `SCHOOL_EVENT` | Closes the school only with `closesSchool: true` (e.g. exams, a ceremony) |
| `MAKEUP_DAY` | Opens a day or shift the school week has off |

`GET /school-calendar?from=&to=` (at most 400 days) returns every date with `morning` and `afternoon` (taught or not) and the entries on it, plus totals (`schoolDays`, `morningDays`, `afternoonDays`, `closedSchoolDays`). A shift is taught when the school week teaches it or a make-up day covers it, unless an entry that closes the school covers it; closing always wins.

**Attendance** can't be recorded when the class's shift has no school that day (`400 SCHOOL_CLOSED`). The attendance sheet (`GET /attendance/class-sections/:id`) says so in `schoolDay: { open, closedBy }`.

**Elsewhere the calendar is used for:**
- **Leave requests:** each one has `schoolDays` next to `days`, counting only the days the student's class has lessons.
- **Dashboard:** `attendanceToday` has `schoolDay: { morning, afternoon, closedBy }` and only counts classes whose shift has school today. `myHomeroom.attendanceToday.schoolDay` gives the same for the teacher's class.

### Announcements

Anyone signed in reads the announcements meant for them. Posting, changing and removing them, and the full list with read counts, need `MANAGE_ANNOUNCEMENTS`.

`POST /announcements` takes `{ title, body, audience, roleIds?, classSectionIds?, priority?, pinned?, publishAt?, expiresAt? }`. Dates and times are ISO 8601 with a time zone, e.g. `2026-11-01T07:00:00+07:00`.

| `audience` | Who sees it |
| --- | --- |
| `EVERYONE` | Every signed-in user |
| `ROLES` | Logins holding any of `roleIds` |
| `CLASSES` | Enrolled students of `classSectionIds`, and those classes' homeroom and subject teachers |

- **When:** an announcement shows from `publishAt` (default: now) until `expiresAt` (none = until deleted).
- **Order in the feed:** pinned first, then `IMPORTANT`, then newest. Each item has `read: true|false`.
- **Read tracking:** `POST /announcements/:id/read` marks one read, `POST /announcements/feed/read-all` marks all, and `GET /announcements/feed/unread-count` gives the count for a badge.
- **Managers:** `GET /announcements?status=SCHEDULED|ACTIVE|EXPIRED` lists every announcement with `recipients` (active logins it is for) and `readCount`.

### Setting up grading

Scores are entered per assessment period: a month such as "January", or an exam period such as "Semester 1". Each period says how every subject is scored in it. Setting up periods and rules needs `MANAGE_ASSESSMENT_RULES`, which Principal and System Admin hold, or a custom Academic Coordinator role.

1. **Create the period:**
   `POST /assessment-periods { academicYearId, name, startDate, endDate, scoreEntryDeadline? }`.
   - The dates must lie within the academic year.
   - Periods are listed in date order.
   - After `scoreEntryDeadline`, teachers can no longer enter scores. Only `ENTER_ANY_SCORES` can correct them.
2. **Set each subject's rules:**
   - Scored directly: `PUT /assessment-periods/:id/subjects/:subjectId { maxTotalScore }`
   - With components: `{ maxTotalScore, components: [{ name, maxScore }] }`. The components must add up to exactly `maxTotalScore`.
   - To reuse another period's rules, for example last month's or the same month last year: `POST /assessment-periods/:id/copy-rules { fromAssessmentPeriodId }`. Subjects that already have rules are skipped.
3. **Teachers enter scores** (see below). A subject's rules freeze once a score is entered under them.
4. **Homeroom teachers calculate results** with `POST /scores/results/calculate`, and write report card remarks with `PATCH /scores/results/remarks { assessmentPeriodId, studentId, remarks }`.
5. **Lock the period** with `POST /assessment-periods/:id/lock`, which needs `LOCK_ASSESSMENT_PERIODS`.
   - A locked period is final: no score, rule, result or remark can change.
   - `POST /:id/unlock` reopens it for corrections. Both are audited.

A period can only be deleted before any score or result exists.

### Entering scores

`POST /scores/subject` records one student's score for one subject in one assessment period. Sending it again corrects the score. It returns `201` the first time and `200` after that.

**Reading a score sheet:** `GET /scores/subject-sheet?classSectionId=&subjectId=&assessmentPeriodId=` returns what a score-entry screen needs for one subject in one class and period:
- the period's rules for the subject (`rules`, or `null` if the subject has none that period);
- every active student, sorted by Khmer name, with their `totalScore` and, in component-based months, their `components` as `componentId → score` (`null` = not entered yet);
- `canEdit` and `lockReason`: `PERIOD_LOCKED`, `DEADLINE_PASSED` (not for `ENTER_ANY_SCORES`), `YEAR_COMPLETED` or `NO_RULES`. These are the same conditions `POST /scores/subject` refuses on.

It has the same scope as entering scores: the subject's assigned teacher in that class (`403 NOT_TEACHING_SUBJECT` otherwise), or anyone with `ENTER_ANY_SCORES`.

**Who can enter scores:** a teacher can teach several subjects in several classes. Each assignment links a teacher, a subject and a class, and each subject in a class has one teacher.
- **Teachers** (`ENTER_SCORES`) can only score the subjects they're assigned to, in the classes they're assigned to. For anything else they get `403 NOT_TEACHING_SUBJECT`.
- **Principal and System Admin** also hold `ENTER_ANY_SCORES`, so they can score any subject in any class, for example to fix a mistake. Every change is audited either way.
- **Managing assignments:** the Academic Coordinator manages assignments. That means anyone holding `UPDATE_CLASS_SECTION` or `UPDATE_STAFF`, which today is Principal and System Admin.
  - `GET /assignments/class/:classSectionId` lists every subject of the class's grade with its teacher, or `teacher: null` if the subject is vacant, plus a count of assigned and vacant subjects.
  - `POST /assignments/subject-teacher { staffId, subjectId, classSectionId }` assigns a teacher. The subject must be taught in that class's grade, and the year must not be completed.
- **A teacher's own classes:** `GET /teacher/my-classes` returns only what the signed-in teacher was assigned in the ACTIVE year, or in `?academicYear=2025-2026`. For each class it gives the subjects they teach there, whether it's their homeroom, and the number of enrolled students.
- **Order of checks:** score entry checks the teacher's scope before it looks at the subject's rules for the month. A teacher outside their scope gets `403` and learns nothing about that subject.
- **Optional `classSectionId`:** a request may include `classSectionId`. It must be the class the student is enrolled in that year, or the request is rejected with `400`.

How the subject is scored depends on that period's `SubjectAssessmentConfig`, so the same subject can follow different rules from month to month:

```jsonc
// Scored directly this month (isComponentBased = false): 0 ≤ totalScoreAchieved ≤ maxTotalScore
{ "studentId": "…", "subjectId": "…", "assessmentPeriodId": "…", "totalScoreAchieved": 44.5 }

// Component-based this month: one score per component (each 0 ≤ score ≤ its maxScore); the total is their sum
{ "studentId": "…", "subjectId": "…", "assessmentPeriodId": "…",
  "components": [{ "componentId": "…", "score": 18 }, { "componentId": "…", "score": 7.5 }, { "componentId": "…", "score": 65 }] }
```

- **Score format:** scores are JSON numbers with at most two decimals.
- **Component-based months:** every component of that month's config must be sent exactly once. Otherwise you get `400 COMPONENTS_MISMATCH`, which lists the unknown, duplicated and missing components. The component scores and the total are saved in one transaction.
- **Refused when:**
  - the period is locked (`409 PERIOD_LOCKED`) or its academic year is completed
  - the period's `scoreEntryDeadline` has passed (`409 SCORE_DEADLINE_PASSED`), except for `ENTER_ANY_SCORES`
  - the subject has no rules for that period (`404 SUBJECT_ASSESSMENT_CONFIG_NOT_FOUND`)
  - the student isn't enrolled that year
  - the subject isn't taught in the student's grade
- **Audit:** every new or changed score is recorded as `SUBJECT_SCORE_RECORDED`, with the previous and new total and component scores.

### Reports in Khmer

All reports follow the MoEYS layout: the school name and code, and the "ព្រះរាជាណាចក្រកម្ពុជា / ជាតិ សាសនា ព្រះមហាក្សត្រ" header. Labels, dates and numbers are in Khmer. Choose the output with `?format=`:

| `format` | Output |
| --- | --- |
| `json` (default) | The report data, for your own frontend |
| `html` | A printable A4 page. Open it in a browser and print, or choose "Save as PDF" to get a PDF |
| `xlsx` | An Excel file with real numbers and dates, e.g. for the district office |

The Khmer fonts (Battambang for text, Moul for headings) are embedded in the page, so Khmer text displays correctly even on a school network with no internet access.

| Report | Endpoint | Who |
| --- | --- | --- |
| Class list (បញ្ជីឈ្មោះសិស្ស) | `GET /reports/class-list/:classSectionId` | `VIEW_CLASS_SECTION` + `LIST_ENROLLMENTS` |
| Gender statistics (ស្ថិតិសិស្ស តាមភេទ) | `GET /reports/gender-statistics?academicYearId=` (default: ACTIVE year) | `LIST_ENROLLMENTS` |
| Report cards (ព្រឹត្តិបត្រពិន្ទុ) | `GET /reports/report-cards/:classSectionId?assessmentPeriodId=&studentId=` | `VIEW_REPORT_CARDS` (homeroom class) or `VIEW_ANY_REPORT_CARDS` |

**Gender statistics:** for each class, each grade subtotal and the whole school, the report gives a total and the number of girls for each column:
- enrolled, which is new admissions + promoted + repeating
- dropped out
- graduated
- still studying

**Report cards:** each card shows the student's subject scores, including components, the total, average, mention, class rank and the teacher's remarks, one A4 page per student. With `xlsx` you get the class's ranked score sheet instead.

**Calculating results:** report cards need results first, calculated with `POST /scores/results/calculate { classSectionId, assessmentPeriodId }`.
- **Who:** `CALCULATE_RESULTS` covers your own homeroom class; `CALCULATE_ANY_RESULTS` covers any class.
- **Missing scores:** calculation is refused while any active student is missing a score. The error lists who is missing which subject.
- **Formula** (in [`src/constants/grading.ts`](src/constants/grading.ts)):
  - **Average:** total ÷ total possible × 100.
  - **Mention:** A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, E ≥ 50, F < 50.
  - **Rank:** by average within the class; equal averages share a rank, as in 1, 1, 3.
- **Recalculating:** you can recalculate at any time before the period is locked, for example after correcting a score. The teacher's remarks are kept.


### Audit log

Every change made through the API is recorded in the `audit_logs` table: who did it, when, from which IP, and what changed. Logins, failed logins and account locks are recorded too. Each entry is written in the same database transaction as the change, so a change is never saved without its entry.

- **What changed:** an update stores only the changed fields, as `before` and `after`. A create stores `after`, and a delete stores `before`. An update that changed nothing isn't recorded.
- **Never stored:** password hashes and temporary passwords. `PASSWORD_RESET` and `PASSWORD_CHANGED` record only that it happened.
- **Survives deletion:** entries copy the actor's username and a readable label for the record, such as `STU-26-0001 Sok Dara — 2026-2027`. They stay meaningful after that login or record is deleted.
- **Scripts:** changes made by the seed and import scripts have no actor.
- **Read-only:** no endpoint can change or delete entries. `db:reset:demo` doesn't remove them either.

`GET /audit-logs` needs `LIST_AUDIT_LOGS`, which System Admin and Principal have. Results are newest first, and paginated with `page` and `pageSize`. Filters:

| Query | Example |
| --- | --- |
| `entityType` | `User`, `Role`, `Enrollment`, `Student`, `Staff`, `ClassSection`, `AcademicYear`, `Grade`, `Subject`, `SchoolSettings` |
| `entityId` | the id of one record, for its full history |
| `action` | `ENROLLMENT_TRANSFERRED`, `USER_ROLES_CHANGED`, `PASSWORD_RESET`, … (all actions are listed in [`src/constants/audit.ts`](src/constants/audit.ts)) |
| `actorUserId` | everything one user did |
| `from`, `to` | dates (`YYYY-MM-DD`), both inclusive |

### Default roles

`db:seed` creates these roles: **System Admin**, **Principal**, **Registrar**, **Teacher** and **Student**. The exact permissions for each are defined in [`src/utils/seed.ts`](src/utils/seed.ts) and [`src/constants/permissions.ts`](src/constants/permissions.ts).

## Postman

Import these files into Postman:

- `postman/school-management.postman_collection.json`
- `postman/local.postman_environment.json`

Set the `password` variable in the environment, then run the login request. The access token is stored automatically for the other requests.
