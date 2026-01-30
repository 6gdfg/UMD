# UMD卡牌游戏服务器

融合UNO、麻将和斗地主的多人卡牌游戏后端服务器。

## 快速开始

### 本地运行

```bash
# Windows
start.bat

# Linux/Mac
npm install
npm run build
npm start
```

服务器将在 `ws://localhost:3000` 启动。

### 测试游戏

在浏览器打开 `test-client.html` 进行测试。

## VPS部署

### 方法1：自动部署（推荐）

```bash
# 上传代码到VPS
scp -r ./* root@你的VPS_IP:/root/umd-game/

# SSH连接到VPS
ssh root@你的VPS_IP
cd umd-game

# 运行部署脚本
chmod +x deploy.sh
./deploy.sh

# 配置防火墙
sudo ufw allow 3000/tcp
sudo ufw enable
```

### 方法2：Docker部署

```bash
docker-compose up -d
```

### 管理命令

```bash
pm2 status              # 查看状态
pm2 logs umd-game       # 查看日志
pm2 restart umd-game    # 重启
pm2 stop umd-game       # 停止
```

## 游戏规则

详见 `rules.md` 文件。

### 核心规则

- **出牌规则**：同色且更大 或 异色且等大
- **牌型**：单张、对子、三张、顺子、连对、飞机、炸弹
- **吃碰杠**：单张出牌时可触发（杠>碰>吃）
- **功能牌**：跳过、反转、+2、+4
- **Pass**：无牌可出时摸一张牌，回合结束
- **UNO**：剩1张牌时必须宣告，否则罚摸2张

## WebSocket API

### 客户端 → 服务器

```javascript
// 创建房间
{ type: 'CREATE_ROOM', playerName: '玩家名' }

// 加入房间
{ type: 'JOIN_ROOM', roomId: 'ABC123', playerName: '玩家名' }

// 开始游戏
{ type: 'START_GAME' }

// 出牌
{ type: 'PLAYER_ACTION', action: { type: 'PLAY_CARDS', cards: [...] } }

// 摸牌
{ type: 'PLAYER_ACTION', action: { type: 'DRAW_CARD' } }

// 吃/碰/杠
{ type: 'PLAYER_ACTION', action: { type: 'CHI'/'PENG'/'GANG', cards: [...] } }

// Pass（自动摸一张牌）
{ type: 'PLAYER_ACTION', action: { type: 'PASS' } }

// 宣告UNO
{ type: 'PLAYER_ACTION', action: { type: 'DECLARE_UNO' } }
```

### 服务器 → 客户端

```javascript
// 游戏状态
{ type: 'GAME_STATE', gameState: {...} }

// 出牌成功
{ type: 'CARDS_PLAYED', playerId, cards, handType, remainingCards }

// 可以吃碰杠
{ type: 'POTENTIAL_ACTION', actions: ['CHI'/'PENG'/'GANG'], targetCard }

// 游戏结束
{ type: 'GAME_OVER', winner, winnerName }

// 错误
{ type: 'ERROR', message }
```

## 项目结构

```
├── src/
│   ├── index.ts      # WebSocket服务器
│   ├── game.ts       # 游戏核心逻辑
│   ├── player.ts     # 玩家管理
│   └── card.ts       # 卡牌系统
├── rules.md          # 游戏规则
├── test-client.html  # 测试客户端
├── deploy.sh         # 部署脚本
└── README.md         # 本文件
```

## 技术栈

- TypeScript + Node.js
- WebSocket (ws库)
- PM2进程管理
- Docker支持

## 开发

```bash
npm run dev     # 开发模式
npm run build   # 编译
npm start       # 启动
```

## 许可证

MIT
