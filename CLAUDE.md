# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Belimo Pulse — a hackathon project (START Hack 2026) for analyzing Belimo smart actuator data (torque, motor position, temperature) to generate actionable HVAC insights. The `Belimo-START-Hack-2026/` directory is a git submodule with challenge details and demo resources.

## Architecture

Monorepo with two independent apps:

- **Frontend** (`frontend/`): Next.js 16 + React 19 + Tailwind CSS 4, deployed to Vercel
- **Backend** (`backend/`): Express 5 + TypeScript, deployed as Docker container on AWS EC2 (port 80 → 8080)
- **Database**: Supabase Postgres, table `pulse_healthchecks` auto-created on backend startup

The frontend never calls the backend directly from the browser. It uses a server-side **bridge route** (`/api/bridge/test`) that proxies requests to the backend, avoiding mixed-content and CORS issues. The backend URL is configured via `API_BASE_URL` env var on Vercel.

## Commands

### Backend (`cd backend`)
```bash
npm run dev          # Dev server with hot reload (tsx watch)
npm run build        # TypeScript compile to dist/
npm start            # Run compiled output
```

### Frontend (`cd frontend`)
```bash
npm run dev          # Next.js dev server (port 3000)
npm run build        # Production build
npm run lint         # ESLint
```

No test framework is configured yet.

## Environment Variables

### Backend (`.env`)
- `DATABASE_URL` (required) — Supabase Postgres connection string
- `DATABASE_SSL` — default `"true"`
- `ALLOWED_ORIGINS` — comma-separated CORS origins, default `http://localhost:3000`
- `PORT` — default `8080`
- `NODE_ENV` — `development`/`test`/`production`

### Frontend (Vercel env)
- `API_BASE_URL` — backend base URL (e.g. `http://18.195.64.10`)

## Deployment

Push to `main` only. GitHub Actions (`.github/workflows/deploy.yml`):
1. Builds backend Docker image → pushes to GHCR → SSHs into EC2 → pulls and runs container
2. After backend is healthy, deploys frontend to Vercel via CLI
3. Runs smoke tests on both services

## Key Patterns

- Backend uses Zod for env validation (`config.ts`) and request body validation
- Backend module layout: `config.ts` (env), `db.ts` (pg pool + queries), `server.ts` (Express app)
- Frontend uses `@/` path alias for `src/`
- Fonts: Space Grotesk (sans) + IBM Plex Mono (mono), set as CSS variables
