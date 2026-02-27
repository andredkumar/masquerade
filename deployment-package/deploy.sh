#!/bin/bash
set -e

echo "🚀 Starting Masquerade Production Deployment..."

# Stop existing processes to prevent port conflicts
echo "🛑 Stopping existing processes..."
pm2 stop all || echo "No PM2 processes running"
pm2 delete all || echo "No PM2 processes to delete"

# Kill any processes on port 5000
echo "🧹 Clearing port 5000..."
lsof -ti:5000 | xargs kill -9 2>/dev/null || echo "Port 5000 is clear"

# Install FFmpeg if needed
echo "🎬 Installing FFmpeg..."
./install-ffmpeg.sh

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Set production environment
export NODE_ENV=production

# Build application
echo "🔨 Building application..."
npm run build

# Create logs directory for PM2
mkdir -p logs

# Verify build was successful
echo "🔍 Verifying production build..."
if [ ! -f "dist/index.js" ]; then
    echo "❌ Build failed: dist/index.js not found"
    exit 1
fi

# Test environment detection
echo "🧪 Testing environment detection..."
if grep -q "process.env.NODE_ENV" server/index.ts; then
    echo "✅ Environment detection uses process.env.NODE_ENV"
else
    echo "⚠️  Warning: Check environment detection in server/index.ts"
fi

# Start with PM2
echo "🚀 Starting with PM2..."
pm2 start ecosystem.config.js --env production

# Wait for startup
sleep 3

# Verify deployment
echo "✅ Verifying deployment..."
RESPONSE=$(curl -s http://localhost:5000 || echo "FAILED")

if echo "$RESPONSE" | grep -q "/assets/" && ! echo "$RESPONSE" | grep -q "@vite/client"; then
    echo "✅ Production deployment successful!"
    echo "   - Static assets: ✅ Found /assets/ references"
    echo "   - Development mode: ✅ No @vite/client found"
    pm2 status
    echo ""
    echo "🌐 Application running at: http://localhost:5000"
    echo "📊 Monitor with: pm2 monit"
    echo "📋 View logs with: pm2 logs maquerade"
    echo "🔄 Restart with: pm2 restart maquerade"
elif echo "$RESPONSE" | grep -q "@vite/client"; then
    echo "❌ ERROR: Development server detected in production!"
    echo "   Found @vite/client - check NODE_ENV environment variable"
    pm2 logs maquerade --lines 20
    exit 1
else
    echo "❌ ERROR: Application not responding correctly"
    echo "Response: $RESPONSE"
    pm2 logs maquerade --lines 20
    exit 1
fi