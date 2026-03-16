# Technical Architecture: Jules Telegram Bot

## Overview
A stateless-first Telegram Bot designed for managing Jules AI coding sessions, deployable on Cloudflare Workers or Vercel.

## Tech Stack
- **Language**: TypeScript
- **Runtime**: Cloudflare Workers / Node.js
- **Web Framework**: [Hono](https://hono.dev/)
- **Bot Framework**: [grammY](https://grammy.dev/)
- **Storage**: Cloudflare KV (Optional, for notifications)
- **Jules API**: RESTful API (v1alpha)

## Key Components

### 1. Telegram Webhook Handler
- Receives updates from Telegram.
- Verifies `SECRET_TOKEN` for security.
- Dispatches commands and callback queries.

### 2. Jules API Client
- Wraps Jules REST endpoints.
- Handles authentication via `X-Goog-Api-Key`.

### 3. Interaction Flow (Stateless)
- **Menu System**: Uses Inline Keyboards with `callback_data` encoding session IDs.
  - Pattern: `action:id` (e.g., `view:session_123`, `approve:session_123`).
- **Session List**: Fetches directly from Jules `/sessions` endpoint.
- **Context Management**: Since it's stateless, the "Current Session" is always derived from the button pressed or the command argument.

### 4. Notification Engine (Optional KV)
- **Trigger**: Cloudflare Workers Cron Trigger (e.g., every 5 minutes).
- **Persistence**: KV stores `last_seen_activity_id` per session.
- **Logic**:
  1. Fetch active sessions.
  2. For each, fetch latest activities.
  3. Compare with KV.
  4. If new significant activity (Milestone/Approval Required), push notification to Telegram.
  5. Update KV.

## Resource Usage (Free Tiers)
- **Cloudflare Workers**: 100k requests/day (Plenty for single user).
- **Cloudflare KV**: 1k writes/day. (Enough for 1000 activity updates/day).
- **Telegram Bot API**: Free.

## Security
- `ADMIN_USER_ID`: Only allows the owner to interact with the bot.
- `JULES_API_KEY`: Kept in environment variables.
- `TELEGRAM_TOKEN`: Kept in environment variables.
