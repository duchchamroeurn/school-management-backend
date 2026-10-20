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

Create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://school:school@localhost:5432/school_management
JWT_SECRET=change-me-to-a-long-random-string
```

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | | PostgreSQL connection string |
| `JWT_SECRET` | Yes | | Secret used to sign access tokens |
| `JWT_EXPIRES_IN` | No | `8h` | Access token lifetime |
| `PORT` | No | `3000` | API port |
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

### First login

Log in as `admin` with the `SEED_ADMIN_PASSWORD` (default `Admin@123!`). You must change the password through `POST /api/v1/auth/change-password` before other endpoints will accept the token.

## Running with Docker

```sh
echo "JWT_SECRET=change-me-to-a-long-random-string" > .env
docker compose up --build
```

This starts three services:

- **db**: PostgreSQL 17 on port `5432`, stored in the `pgdata` volume
- **migrate**: a one-off job that pushes the schema and seeds default data, then exits
- **api**: the API on port `3000` (override with `API_PORT`), started once `migrate` succeeds

You can also set `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `SEED_ADMIN_USERNAME` and `SEED_ADMIN_PASSWORD` in `.env`.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the API with watch mode (`tsx`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled API |
| `npm run db:push` | Sync `prisma/schema.prisma` to the database |
| `npm run db:studio` | Open Prisma Studio |
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
| Users | `GET /users`, `GET /users/:id`, `POST /users`, `PUT /users/:id/roles`, `PATCH /users/:id/status`, `POST /users/:id/reset-password`, `DELETE /users/:id` |
| Roles | `GET /roles`, `GET /roles/:id` |
| Staff | CRUD on `/staff`, plus `POST /staff/assign-homeroom` |
| Students | CRUD on `/students` |
| Academic years | CRUD on `/academic-years` |
| Grades | CRUD on `/grades` |
| Subjects | CRUD on `/subjects`, plus `POST /subjects/:id/grades` and `DELETE /subjects/:id/grades/:gradeId` |
| Class sections | CRUD on `/class-sections`, plus `GET /class-sections/:id/roster` |
| Enrollments | CRUD on `/enrollments` |

"CRUD" means `GET /`, `GET /:id`, `POST /`, `PATCH /:id` and `DELETE /:id`.

### Default roles

`db:seed` creates these roles: **System Admin**, **Principal**, **Registrar**, **Teacher** and **Student**. The exact permissions for each are defined in [`src/utils/seed.ts`](src/utils/seed.ts) and [`src/constants/permissions.ts`](src/constants/permissions.ts).

## Postman

Import these files into Postman:

- `postman/school-management.postman_collection.json`
- `postman/local.postman_environment.json`

Set the `password` variable in the environment, then run the login request. The access token is stored automatically for the other requests.
