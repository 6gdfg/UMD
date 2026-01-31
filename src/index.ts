/**
 * WebSocket服务器入口
 * 处理客户端连接和房间管理
 */

import WebSocket, { WebSocketServer } from 'ws';
import { Game, PlayerAction } from './game';
import { createServer } from 'http';

// 房间管理
const games = new Map<string, Game>();

// 玩家到房间的映射
const playerRooms = new Map<string, string>();

// 创建HTTP服务器
// Handle plain HTTP requests so a reverse proxy (e.g. nginx) doesn't wait forever.
const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('ok');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('UMD game server is running. Use WebSocket on this host/port.');
});

// 创建WebSocket服务器
const wss = new WebSocketServer({ server });

console.log('UMD卡牌游戏服务器启动中...');

/**
 * 处理WebSocket连接
 */
wss.on('connection', (ws: WebSocket) => {
  console.log('新客户端连接');

  let playerId: string | null = null;
  let playerName: string | null = null;
  let roomId: string | null = null;

  // 处理客户端消息
  ws.on('message', (data: string) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('收到消息:', message);

      switch (message.type) {
        case 'JOIN_ROOM':
          handleJoinRoom(ws, message);
          break;

        case 'CREATE_ROOM':
          handleCreateRoom(ws, message);
          break;

        case 'START_GAME':
          handleStartGame(message);
          break;

        case 'PLAYER_ACTION':
          handlePlayerAction(message);
          break;

        case 'LEAVE_ROOM':
          handleLeaveRoom();
          break;

        default:
          ws.send(JSON.stringify({
            type: 'ERROR',
            message: '未知的消息类型'
          }));
      }
    } catch (error) {
      console.error('处理消息错误:', error);
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: '消息格式错误'
      }));
    }
  });

  // 处理断开连接
  ws.on('close', () => {
    console.log('客户端断开连接');
    handleLeaveRoom();
  });

  // 处理错误
  ws.on('error', (error) => {
    console.error('WebSocket错误:', error);
  });

  /**
   * 处理创建房间
   */
  function handleCreateRoom(ws: WebSocket, message: any) {
    const newRoomId = generateRoomId();
    const game = new Game(newRoomId);
    games.set(newRoomId, game);

    playerId = message.playerId || generatePlayerId();
    playerName = message.playerName || `玩家${playerId!.substring(0, 4)}`;
    roomId = newRoomId;

    game.addPlayer(playerId!, playerName!, ws);
    playerRooms.set(playerId!, roomId!);

    ws.send(JSON.stringify({
      type: 'ROOM_CREATED',
      roomId: newRoomId,
      playerId: playerId,
      playerName: playerName
    }));

    console.log(`房间 ${newRoomId} 创建成功，玩家 ${playerName} 加入`);
  }

  /**
   * 处理加入房间
   */
  function handleJoinRoom(ws: WebSocket, message: any) {
    const targetRoomId = message.roomId;
    const game = games.get(targetRoomId);

    if (!game) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: '房间不存在'
      }));
      return;
    }

    playerId = message.playerId || generatePlayerId();
    playerName = message.playerName || `玩家${playerId!.substring(0, 4)}`;
    roomId = targetRoomId;

    const success = game.addPlayer(playerId!, playerName!, ws);

    if (success) {
      playerRooms.set(playerId!, roomId!);
      ws.send(JSON.stringify({
        type: 'ROOM_JOINED',
        roomId: roomId,
        playerId: playerId,
        playerName: playerName
      }));
      console.log(`玩家 ${playerName} 加入房间 ${roomId}`);
    } else {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: '无法加入房间（房间已满或游戏已开始）'
      }));
    }
  }

  /**
   * 处理开始游戏
   */
  function handleStartGame(message: any) {
    if (!roomId) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: '你不在任何房间中'
      }));
      return;
    }

    const game = games.get(roomId);
    if (!game) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: '房间不存在'
      }));
      return;
    }

    const success = game.startGame();
    if (!success) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: '无法开始游戏（玩家人数不足或游戏已开始）'
      }));
    }
  }

  /**
   * 处理玩家动作
   */
  function handlePlayerAction(message: any) {
    if (!roomId || !playerId) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: '你不在任何房间中'
      }));
      return;
    }

    const game = games.get(roomId);
    if (!game) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: '房间不存在'
      }));
      return;
    }

    const action: PlayerAction = {
      type: message.action.type,
      cards: message.action.cards,
      selectedColor: message.action.selectedColor,
      playerId: playerId
    };

    game.handlePlayerAction(action);
  }

  /**
   * 处理离开房间
   */
  function handleLeaveRoom() {
    if (playerId && roomId) {
      const game = games.get(roomId);
      if (game) {
        game.removePlayer(playerId);
        
        // 如果房间没人了，删除房间
        if (game.players.length === 0) {
          games.delete(roomId);
          console.log(`房间 ${roomId} 已删除（无玩家）`);
        }
      }
      playerRooms.delete(playerId);
      console.log(`玩家 ${playerName} 离开房间 ${roomId}`);
    }
  }
});

/**
 * 生成随机房间ID
 */
function generateRoomId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * 生成随机玩家ID
 */
function generatePlayerId(): string {
  return `player_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ UMD卡牌游戏服务器运行在端口 ${PORT}`);
  console.log(`WebSocket地址: ws://localhost:${PORT}`);
  console.log('等待玩家连接...\n');
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到SIGTERM信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n收到SIGINT信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});
