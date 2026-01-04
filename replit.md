# SMC & Solana Auto-Trading Bot

## Overview

This is a full-stack trading terminal that combines two major systems:

1. **SMC Market Analysis & Auto-Signals** - Professional swing-trading logic for Crypto and Forex markets using Smart Money Concepts (SMC) analysis
2. **Solana Auto-Trading System** - Wallet management and trade execution via Jupiter aggregator

The application provides a web dashboard for monitoring signals, managing wallets, and viewing trade history, with a Telegram bot interface for market analysis commands.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight React router)
- **State Management**: TanStack React Query for server state
- **UI Components**: shadcn/ui with Radix primitives
- **Styling**: Tailwind CSS with custom theme variables
- **Build Tool**: Vite with hot module replacement

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript (ESM modules)
- **API Pattern**: REST endpoints defined in `shared/routes.ts` with Zod validation
- **Authentication**: Replit Auth with OpenID Connect, session-based with PostgreSQL session store
- **Bot Integration**: Telegram Bot API with polling mode

### Data Storage
- **Database**: PostgreSQL with Drizzle ORM
- **Schema Location**: `shared/schema.ts` (main) and `shared/models/` (auth, chat)
- **Migrations**: Drizzle Kit with `drizzle-kit push` command
- **Tables**: users, sessions, wallets, signals, trades, conversations, messages

### Key Design Patterns
- Shared types between frontend and backend via `@shared/*` path alias
- Storage abstraction layer (`server/storage.ts`) for database operations
- Modular integration system under `server/replit_integrations/` for auth, chat, image, and batch processing
- Background worker for automated signal generation (`server/signals-worker.ts`)

### Trading Logic
- SMC analysis uses GPT-4 via OpenAI API for market scanning
- Solana trades execute through Jupiter aggregator API
- Safety checks include: mint validation, authority checks, liquidity verification, route availability
- User safety profiles control slippage and risk parameters

## External Dependencies

### AI Services
- **OpenAI API** - GPT-4 for market analysis and image generation (via Replit AI Integrations)
- Configured through `AI_INTEGRATIONS_OPENAI_API_KEY` and `AI_INTEGRATIONS_OPENAI_BASE_URL`

### Blockchain
- **Solana Web3.js** - Wallet operations and transaction signing
- **Jupiter Aggregator** - Token swap routing and execution (`https://quote-api.jup.ag/v6/`)
- RPC endpoint configurable for mainnet/devnet

### Messaging
- **Telegram Bot API** - Bot interface for analysis commands
- Requires `TELEGRAM_BOT_TOKEN` environment variable

### Database
- **PostgreSQL** - Primary data store
- Requires `DATABASE_URL` environment variable
- Uses `connect-pg-simple` for session storage

### Required Environment Variables
- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Express session secret
- `TELEGRAM_BOT_TOKEN` - Telegram bot authentication
- `AI_INTEGRATIONS_OPENAI_API_KEY` - OpenAI API key
- `AI_INTEGRATIONS_OPENAI_BASE_URL` - OpenAI API base URL
- `ISSUER_URL` - Replit OIDC issuer (defaults to `https://replit.com/oidc`)
- `REPL_ID` - Replit environment identifier