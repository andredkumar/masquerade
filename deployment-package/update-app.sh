#!/bin/bash
set -e

echo "🔄 Updating Masquerade Application..."

# Stop existing processes first to prevent port conflicts
echo "🛑 Stopping existing application..."
pm2 stop maquerade || echo "Application not running"

# Kill any processes on port 5000
echo "🧹 Clearing port 5000..."
lsof -ti:5000 | xargs kill -9 2>/dev/null || echo "Port 5000 is clear"

# Install any new dependencies
echo "📦 Updating dependencies..."
npm install

# Set production environment
export NODE_ENV=production

# Build application
echo "🔨 Building updated application..."
npm run build

# Verify build
if [ ! -f "dist/index.js" ]; then
    echo "❌ Build failed: dist/index.js not found"
    exit 1
fi

# Restart application
echo "🚀 Restarting application..."
pm2 restart maquerade || pm2 start ecosystem.config.js --env production

# Wait for startup
sleep 3

# Verify update
echo "✅ Verifying update..."
RESPONSE=$(curl -s http://localhost:5000 || echo "FAILED")

if echo "$RESPONSE" | grep -q "/assets/" && ! echo "$RESPONSE" | grep -q "@vite/client"; then
    echo "✅ Application update successful!"
    pm2 status
else
    echo "❌ Update verification failed"
    pm2 logs maquerade --lines 10
    exit 1
fi