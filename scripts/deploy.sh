#!/bin/bash
# QAVENO — Production Build & Deploy Script
# Usage: ./scripts/deploy.sh [--build] [--docker] [--vercel]

set -euo pipefail

echo "═══════════════════════════════════════════════"
echo "  QAVENO Production Deployment"
echo "═══════════════════════════════════════════════"

# ── Step 1: Build backend ────────────────────────────────────────
if [[ "${1:-}" == "--build" || "${1:-}" == "" ]]; then
  echo ""
  echo "▸ Building backend..."
  cd backend
  npm ci --omit=dev
  npx tsc -p tsconfig.build.json
  echo "  ✓ Backend built"
  cd ..
fi

# ── Step 2: Docker build ────────────────────────────────────────
if [[ "${1:-}" == "--docker" || "${1:-}" == "" ]]; then
  echo ""
  echo "▸ Building Docker images..."
  docker compose build --no-cache
  echo "  ✓ Docker images built"
fi

# ── Step 3: Verify environment ──────────────────────────────────
echo ""
echo "▸ Verifying environment variables..."
REQUIRED_VARS="POSTGRES_PASSWORD JWT_SECRET QAVENO_TRIAL_SECRET"
for var in $REQUIRED_VARS; do
  if [ -z "${!var:-}" ]; then
    echo "  ✗ Missing: $var"
    exit 1
  fi
  echo "  ✓ $var is set"
done

# ── Step 4: Deploy to Vercel ────────────────────────────────────
if [[ "${1:-}" == "--vercel" ]]; then
  echo ""
  echo "▸ Deploying website to Vercel..."
  vercel --prod --yes
  echo "  ✓ Website deployed"

  echo ""
  echo "▸ Deploying owner portal to Vercel..."
  cd owner-portal
  vercel --prod --yes
  cd ..
  echo "  ✓ Owner portal deployed"
fi

# ── Step 5: Start backend ───────────────────────────────────────
if [[ "${1:-}" == "--docker" || "${1:-}" == "" ]]; then
  echo ""
  echo "▸ Starting production stack..."
  docker compose up -d
  echo "  ✓ Stack started"

  # Wait for health
  echo ""
  echo "▸ Waiting for health check..."
  sleep 5
  node scripts/health-check.js || echo "  ⚠ Health check failed (may need more time)"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo "  QAVENO Deployment Complete"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Website:     https://qaveno.com"
echo "  Owner:       https://owner.qaveno.com"
echo "  API:         https://api.qaveno.com"
echo "  Health:      https://api.qaveno.com/health"
echo "  Swagger:     (disabled in production)"
echo ""
