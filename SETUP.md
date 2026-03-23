# Real Estate CRM Setup Guide

## Prerequisites

- Node.js 18+
- PostgreSQL (local, Docker, Supabase, Neon, Render, etc.)
- GROQ API key (or OpenAI API key if you choose OpenAI provider)
- RealEstateAPI key
- AWS Cognito User Pool + App Client (for login)

## Environment Setup

Create or edit `.env.local` in the project root:

```env
# Database (required)
POSTGRES_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME
# You can use DATABASE_URL instead of POSTGRES_URL if preferred
# Optional dev-only fallback (disabled by default)
# DEV_IN_MEMORY_DB=true

# Optional external URL (production)
NEXT_PUBLIC_BASE_URL=https://your-domain.com

# AI provider
AI_PROVIDER=groq
GROQ_API_KEY=your-groq-api-key
OPENAI_MODEL=openai/gpt-oss-120b

# Real estate data
REAL_ESTATE_API_KEY=your-realestateapi-key
REAL_ESTATE_USER_ID=CRMApp

# Optional: bridge CRM assistant to local Snaphomz-ai-search
AI_SEARCH_BASE_URL=http://localhost:8001

# Cognito auth (required to enable login gate)
NEXT_PUBLIC_COGNITO_REGION=us-east-1
NEXT_PUBLIC_COGNITO_USER_POOL_ID=us-east-1_xxxxxxxx
NEXT_PUBLIC_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
NEXT_PUBLIC_COGNITO_DOMAIN=your-domain-prefix.auth.us-east-1.amazoncognito.com
NEXT_PUBLIC_COGNITO_REDIRECT_URI=http://localhost:3000/auth/callback
NEXT_PUBLIC_COGNITO_LOGOUT_URI=http://localhost:3000
```

## Cognito App Client Settings

In Cognito User Pool -> App integration -> App client:

1. Enable Authorization code grant.
2. Allowed callback URL: `http://localhost:3000/auth/callback`
3. Allowed sign-out URL: `http://localhost:3000`
4. Scopes: `openid`, `email`, `profile`

## Install and Run (npm)

```bash
npm install
npm run dev:no-reload
```

App URL: `http://localhost:3000`

## Seed Sample Data

```bash
node seed-data.js
```

The seed script writes sample leads into Postgres table `crm_documents` (collection `leads`).

## Production

```bash
npm run build
npm run start
```

## Troubleshooting

1. `Missing DATABASE_URL (or POSTGRES_URL)`:
   - Add `POSTGRES_URL` (or `DATABASE_URL`) in `.env.local` and restart dev server.
   - Use `DEV_IN_MEMORY_DB=true` only for temporary local development.
2. `connect ECONNREFUSED ... 5432`:
   - Postgres is not running or host/port is wrong.
3. RealEstateAPI `401 Unauthorized`:
   - Replace placeholder key with a valid paid/active key.
4. AI fallback/template responses:
   - Ensure `AI_PROVIDER=groq` and `GROQ_API_KEY` are set, then restart dev server.
5. Cognito keeps returning to login:
   - Verify callback/sign-out URLs in Cognito exactly match your `.env.local` values.
