#!/bin/bash
echo "🚀 Deploying to Masquerade server..."
git push origin main
ssh -i ~/Desktop/ultrasound-app-key.pem ubuntu@3.136.48.97 << 'ENDSSH'
cd ~/template-masking-app
git fetch origin main
git reset --hard origin/main
npm install
npm run build
pm2 restart masquerade --update-env
pm2 logs masquerade --lines 5
ENDSSH
echo "✅ Deploy complete"
