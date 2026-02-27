#!/bin/bash
echo "🎬 Installing FFmpeg for Masquerade..."

# Detect OS
if [ -f /etc/amazon-linux-release ]; then
    echo "✅ Detected Amazon Linux"
    sudo yum update -y
    sudo amazon-linux-extras install epel -y
    sudo yum install -y ffmpeg ffmpeg-devel
elif [ -f /etc/ubuntu-release ] || [ -f /etc/debian_version ]; then
    echo "✅ Detected Ubuntu/Debian"
    sudo apt update
    sudo apt install -y ffmpeg
else
    echo "❌ Unsupported OS. Please install FFmpeg manually."
    echo "See FFMPEG-SETUP.md for detailed instructions."
    exit 1
fi

echo "🔍 Verifying installation..."
if command -v ffmpeg &> /dev/null && command -v ffprobe &> /dev/null; then
    echo "✅ FFmpeg installed successfully!"
    echo "FFmpeg version:"
    ffmpeg -version | head -1
    echo "FFprobe version:"
    ffprobe -version | head -1
    echo ""
    echo "🚀 You can now run Masquerade!"
    echo "   npm install && npm run build && npm start"
else
    echo "❌ FFmpeg installation failed"
    echo "Please check FFMPEG-SETUP.md for troubleshooting steps"
    exit 1
fi