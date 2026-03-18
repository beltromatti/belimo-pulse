Start Hackathon 2026

## Backend
- Node.js
- TypeScript
- Express.js
- Docker
- AWS EC2 deploy
- Supabase Postgres

## Frontend
- Next.js
- React
- TypeScript
- Tailwind CSS
- Vercel deploy

## Runtime
- Backend public health: `http://18.195.64.10/health`
- Frontend production: `https://belimo-pulse.vercel.app`
- Frontend bridge route: `POST /api/bridge/test`
- Database table created on startup: `pulse_healthchecks`

## Deploy
- Push su `main` soltanto
- GitHub Actions job `build_image` builda il backend e pubblica l'immagine su GHCR
- GitHub Actions job `deploy` fa pull sul server AWS, mette online il container e rimuove le immagini backend obsolete
- Il frontend usa il Git integration nativo di Vercel sul repository `beltromatti/belimo-pulse`
