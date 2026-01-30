#!/bin/bash

# UMD卡牌游戏服务器部署脚本
# 使用方法: chmod +x deploy.sh && ./deploy.sh

echo "🚀 开始部署UMD卡牌游戏服务器..."

# 检查Node.js是否安装
if ! command -v node &> /dev/null; then
    echo "❌ Node.js未安装，正在安装..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "✅ Node.js版本: $(node -v)"
echo "✅ NPM版本: $(npm -v)"

# 安装依赖
echo "📦 安装依赖..."
npm install

# 编译TypeScript
echo "🔨 编译TypeScript..."
npm run build

# 检查PM2是否安装
if ! command -v pm2 &> /dev/null; then
    echo "📦 安装PM2..."
    sudo npm install -g pm2
fi

# 停止旧进程（如果存在）
echo "🛑 停止旧进程..."
pm2 stop umd-game 2>/dev/null || true
pm2 delete umd-game 2>/dev/null || true

# 启动新进程
echo "▶️  启动服务器..."
pm2 start dist/index.js --name umd-game

# 保存PM2配置
pm2 save

# 设置开机自启
pm2 startup

echo ""
echo "✅ 部署完成！"
echo ""
echo "📊 查看状态: pm2 status"
echo "📝 查看日志: pm2 logs umd-game"
echo "🔄 重启服务: pm2 restart umd-game"
echo "🛑 停止服务: pm2 stop umd-game"
echo ""
echo "🌐 服务器运行在: ws://$(hostname -I | awk '{print $1}'):3000"
echo ""
