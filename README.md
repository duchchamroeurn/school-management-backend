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
cp .env.example .env     # then set JWT_SECRET and CORS_ORIGINS
docker compose up --build
```

This starts four services:

- **db**: PostgreSQL 17 on port `5432`, stored in the `pgdata` volume
- **migrate**: a one-off job that pushes the schema and seeds default data, then exits
- **api**: the API on port `3000` (override with `API_PORT`), started once `migrate` succeeds
- **backup**: nightly database backups (see [Backups](#backups))

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

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the API with watch mode (`tsx`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled API |
| `npm run db:push` | Sync `prisma/schema.prisma` to the database |
| `npm run db:studio` | Open Prisma Studio |
| `npm run jwt:secret` | Write a random `JWT_SECRET` into `.env` |
| `npm run db:seed` | Seed reference data and the root admin |
| `npm run db:seed:students` | Import students from `data/students.json` |
| `npm run db:seed:staff` | Import staff from `data/staff.json` |
| `npm run db:seed:demo` | Build a demo school on top of the imported data |
| `npm run db:reset:demo` | Remove the demo data and rebuild it |

### Importing students and staff

The import scripts read JSON files from `data/`. That folder holds real personal data, so it is **git-ignored and never committed**.

```sh
npm run db:seed:students -- --dry-run            # Validate only
npm run db:seed:students                         # Validate and import
npm run db:seed:staff -- path/to/staff.json      # Import from a custom file
```

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
| Teacher | `GET /teacher/my-classes?academicYear=` |
| Audit log | `GET /audit-logs` |
| Scores | `POST /scores/subject`, `POST /scores/results/calculate` |
| Reports | `GET /reports/class-list/:classSectionId`, `GET /reports/gender-statistics`, `GET /reports/report-cards/:classSectionId` |
| Users | `GET /users`, `GET /users/:id`, `POST /users`, `PUT /users/:id/roles`, `PATCH /users/:id/status`, `POST /users/:id/reset-password`, `DELETE /users/:id` |
| Roles | `GET /roles`, `GET /roles/:id` |
| Staff | CRUD on `/staff`, plus `POST /staff/assign-homeroom` |
| Students | CRUD on `/students` |
| Academic years | CRUD on `/academic-years` |
| Grades | CRUD on `/grades` |
| Subjects | CRUD on `/subjects`, plus `POST /subjects/:id/grades` and `DELETE /subjects/:id/grades/:gradeId` |
| Class sections | CRUD on `/class-sections`, plus `GET /class-sections/:id/roster` and `POST /class-sections/:id/promote` |
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

### Entering scores

`POST /scores/subject` records one student's score for one subject in one assessment period. Sending it again corrects the score. It returns `201` the first time and `200` after that.

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
