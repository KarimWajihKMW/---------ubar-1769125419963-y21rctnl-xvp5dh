#!/bin/bash
set -e

echo "🔧 Configuring git..."
git config --global user.name "GitHub Copilot" || true
git config --global user.email "copilot@github.com" || true

echo "📝 Adding files..."
git add -A

echo "💾 Committing..."
git commit -m "feat: Add Driver Earnings System - نظام أرباح السائقين

✅ Features:
- driver_earnings table for daily earnings tracking
- API endpoints: GET /api/drivers/:id/stats & /api/drivers/:id/earnings  
- earnings.html with live updates every 10 seconds
- Comprehensive test suite and documentation in Arabic
- Auto-refresh capabilities

📋 Files Added:
- DRIVER_EARNINGS_COMPLETE.md - Full documentation
- test-earnings-system.js - Comprehensive tests
- check-tables.js - Table verification
- check-driver-earnings-table.js - Earnings table check
- run-earnings-test.sh - Test runner script
- demo-live-update.sh - Demo script

🎯 Database Tables:
1. drivers - with earnings columns (today_earnings, total_earnings, balance, etc.)
2. driver_earnings - daily historical earnings records with UNIQUE constraint

🔌 API Endpoints Working:
- GET /api/drivers/:id/stats
- GET /api/drivers/:id/earnings?days=30

🌐 Frontend:
- earnings.html - Full earnings display page with auto-refresh
" || echo "No changes to commit"

echo "🚀 Pushing to main..."
git push origin main || echo "Push failed - may need authentication"

echo "✅ Done!"
