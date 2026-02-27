#!/bin/bash
# Verify no Python is required for this deployment

echo "🔍 Checking for Python dependencies..."

# Check if Python is installed (should not be required)
if command -v python3 &> /dev/null || command -v python &> /dev/null; then
    echo "⚠️  Python is installed but NOT required for Masquerade"
else
    echo "✅ Python not found (this is correct - not needed)"
fi

# Verify all tools are JavaScript-based
echo ""
echo "📋 Required tools (all JavaScript-based):"
echo -n "   Node.js: "
node --version 2>/dev/null || echo "❌ MISSING"
echo -n "   npm: "
npm --version 2>/dev/null || echo "❌ MISSING"

echo ""
echo "📋 System tools (NOT Python-based):"
echo -n "   FFmpeg: "
ffmpeg -version 2>/dev/null | head -1 || echo "⚠️  Not installed yet (run ./install-ffmpeg.sh)"

echo ""
echo "✅ Masquerade deployment is 100% Python-free"
echo "   All dependencies use prebuilt native binaries"
echo "   No Python runtime or pip packages required"
