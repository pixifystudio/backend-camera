#!/bin/bash

set -e
LOG_FILE="$HOME/pixbox_setup.log"
BACKEND_DIR="$HOME/pixbox"

echo "📦 PixBox WSL2 Setup Started at $(date)" | tee $LOG_FILE

echo "🔄 Updating system packages..." | tee -a $LOG_FILE
sudo apt update && sudo apt upgrade -y | tee -a $LOG_FILE

echo "📥 Installing required packages..." | tee -a $LOG_FILE
sudo apt install -y curl net-tools vim ffmpeg gphoto2 | tee -a $LOG_FILE

echo "🟢 Installing Node.js v18.20.0..." | tee -a $LOG_FILE
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - | tee -a $LOG_FILE
sudo apt install -y nodejs | tee -a $LOG_FILE

echo "🌐 Installing global npm tools (pm2, http-server)..." | tee -a $LOG_FILE
sudo npm install -g pm2 http-server | tee -a $LOG_FILE


if [ -d "$BACKEND_DIR" ]; then
  echo "🔧 Installing backend-camera dependencies..." | tee -a $LOG_FILE
  cd "$BACKEND_DIR"
  npm install | tee -a $LOG_FILE

  echo "🚀 Starting backend-camera using PM2..." | tee -a $LOG_FILE
  pm2 start npm --name backend-camera -- run start | tee -a $LOG_FILE
  pm2 save | tee -a $LOG_FILE
else
  echo "❌ ERROR: Backend-camera folder not found at $BACKEND_DIR" | tee -a $LOG_FILE
  exit 1
fi

echo "⚙️ Enabling PM2 startup on WSL boot..." | tee -a $LOG_FILE
pm2 startup | tee -a $LOG_FILE

echo "" | tee -a $LOG_FILE
echo "✅ PixBox setup completed successfully!" | tee -a $LOG_FILE
echo "📄 Log saved at: $LOG_FILE"
