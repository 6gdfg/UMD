import WebSocket, { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { CoinSettlementPayload, Game, PlayerAction } from './game';
import { logger } from './logger';
import { verifyAuthToken } from './auth';
import { getUserById, persistCoinSettlement } from './coin-store';

const games = new Map<string, Game>();
const playerRooms = new Map<string, string>();
const runtimePlayerToUserId = new Map<string, string>();

// Allow quick app/browser switch without "instant elimination".
// If the player reconnects with the same playerId within this window, they keep the seat.
const DISCONNECT_GRACE_MS = 10_000;
const disconnectTimers = new Map<string, NodeJS.Timeout>();
const DEFAULT_BASE_BET = 100;

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

const wss = new WebSocketServer({ server });

function generateRoomId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generatePlayerId(): string {
  return `player_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function parseBaseBet(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BASE_BET;
  return Math.floor(n);
}

function userAlreadyInActiveRoom(userId: string, exceptPlayerId?: string): boolean {
  for (const [runtimePlayerId, mappedUserId] of runtimePlayerToUserId.entries()) {
    if (mappedUserId !== userId) continue;
    if (exceptPlayerId && runtimePlayerId === exceptPlayerId) continue;

    const rid = playerRooms.get(runtimePlayerId);
    if (!rid) continue;

    const game = games.get(rid);
    if (!game) continue;

    const exists = game.players.some(player => player.id === runtimePlayerId);
    if (exists) return true;
  }

  return false;
}

function attachCoinSettlementPersistence(game: Game): void {
  game.setCoinSettlementHandler(async (payload: CoinSettlementPayload) => {
    const updates: Array<{ userId: string; coins: number }> = [];
    for (const detail of payload.details) {
      const userId = runtimePlayerToUserId.get(detail.playerId);
      if (!userId) {
        logger.warn('coin_settlement_user_mapping_missing', {
          roomId: payload.roomId,
          playerId: detail.playerId
        });
        continue;
      }
      updates.push({ userId, coins: detail.after });
    }

    if (updates.length === 0) return;
    await persistCoinSettlement(updates);
    logger.info('coin_settlement_persisted', {
      roomId: payload.roomId,
      winnerId: payload.winnerId,
      affectedUsers: updates.length
    });
  });
}

wss.on('connection', (ws: WebSocket) => {
  logger.info('ws_connected');
  let playerId: string | null = null;
  let playerName: string | null = null;
  let roomId: string | null = null;
  let authUserId: string | null = null;

  ws.on('message', async (data: string) => {
    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch {
      ws.send(
        JSON.stringify({
          type: 'ERROR',
          message: 'Invalid message format'
        })
      );
      return;
    }

    logger.debug('ws_message', { type: message?.type, playerId, roomId });

    try {
      switch (message.type) {
        case 'CREATE_ROOM':
          await handleCreateRoom(message);
          break;
        case 'JOIN_ROOM':
          await handleJoinRoom(message);
          break;
        case 'START_GAME':
          handleStartGame();
          break;
        case 'PLAYER_ACTION':
          handlePlayerAction(message);
          break;
        case 'LEAVE_ROOM':
          handleLeaveRoom();
          break;
        default:
          ws.send(
            JSON.stringify({
              type: 'ERROR',
              message: 'Unknown message type'
            })
          );
      }
    } catch (error) {
      logger.error('ws_message_handler_failed', {
        error: error instanceof Error ? error.message : String(error),
        messageType: message?.type,
        playerId,
        roomId
      });
      ws.send(
        JSON.stringify({
          type: 'ERROR',
          message: 'Server error'
        })
      );
    }
  });

  ws.on('close', () => {
    logger.info('ws_closed', { playerId, roomId });
    handleDisconnect(ws);
  });

  ws.on('error', () => {
    // close will handle cleanup
    logger.warn('ws_error', { playerId, roomId });
  });

  async function authenticate(message: any): Promise<{ id: string; username: string; coins: number } | null> {
    const rawToken = typeof message?.token === 'string' ? message.token : '';
    const token = rawToken.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Authentication required' }));
      return null;
    }

    const decoded = verifyAuthToken(token);
    if (!decoded) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid token' }));
      return null;
    }

    let user = null;
    try {
      user = await getUserById(decoded.userId);
    } catch (error) {
      logger.error('auth_user_lookup_failed', {
        error: error instanceof Error ? error.message : String(error),
        userId: decoded.userId
      });
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Authentication service unavailable' }));
      return null;
    }
    if (!user) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'User not found' }));
      return null;
    }
    return user;
  }

  async function handleCreateRoom(message: any) {
    const user = await authenticate(message);
    if (!user) return;
    if (userAlreadyInActiveRoom(user.id)) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'User already in another room' }));
      return;
    }

    const newRoomId = generateRoomId();
    const baseBet = parseBaseBet(message.baseBet);
    const game = new Game(newRoomId, baseBet);
    attachCoinSettlementPersistence(game);
    games.set(newRoomId, game);

    const id: string = message.playerId || generatePlayerId();
    const name: string = user.username;
    const rid: string = newRoomId;

    playerId = id;
    playerName = name;
    roomId = rid;
    authUserId = user.id;

    const added = game.addPlayer(id, name, ws, user.coins);
    if (!added) {
      ws.send(
        JSON.stringify({
          type: 'ERROR',
          message: 'Insufficient coins for base bet'
        })
      );
      games.delete(rid);
      playerId = null;
      playerName = null;
      roomId = null;
      authUserId = null;
      return;
    }
    runtimePlayerToUserId.set(id, user.id);
    playerRooms.set(id, rid);

    logger.info('room_created', { roomId: rid, playerId: id, playerName: name, baseBet, coins: user.coins, authUserId: user.id });
    ws.send(
      JSON.stringify({
        type: 'ROOM_CREATED',
        roomId: rid,
        playerId: id,
        playerName: name,
        baseBet,
        coins: user.coins
      })
    );
  }

  async function handleJoinRoom(message: any) {
    const user = await authenticate(message);
    if (!user) return;

    const targetRoomId = message.roomId;
    const game = games.get(targetRoomId);
    if (!game) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' }));
      return;
    }

    const requestedPlayerId = message.playerId || generatePlayerId();
    const requestedPlayerName = user.username;

    // Reconnect: keep the seat if playerId already exists in this room.
    const existing = game.players.find(p => p.id === requestedPlayerId);
    if (existing) {
      const mappedUserId = runtimePlayerToUserId.get(requestedPlayerId);
      if (mappedUserId && mappedUserId !== user.id) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Player identity mismatch' }));
        return;
      }

      const timer = disconnectTimers.get(requestedPlayerId);
      if (timer) clearTimeout(timer);
      disconnectTimers.delete(requestedPlayerId);

      const oldWs = game.getPlayerWs(requestedPlayerId);
      if (oldWs && oldWs !== ws) {
        try {
          oldWs.close(4000, 'replaced by reconnect');
        } catch {}
      }

      game.reconnectPlayer(requestedPlayerId, ws);

      playerId = requestedPlayerId;
      playerName = existing.name;
      roomId = targetRoomId;
      authUserId = user.id;
      playerRooms.set(requestedPlayerId, targetRoomId);
      runtimePlayerToUserId.set(requestedPlayerId, user.id);

      logger.info('player_reconnected', {
        roomId: targetRoomId,
        playerId: requestedPlayerId,
        playerName: existing.name,
        authUserId: user.id
      });
        ws.send(
          JSON.stringify({
            type: 'ROOM_JOINED',
            roomId: targetRoomId,
            playerId: requestedPlayerId,
            playerName: existing.name,
            baseBet: game.baseBet,
            coins: user.coins,
            reconnected: true
          })
        );
        // Ensure the reconnecting client ends up with the latest authoritative state,
        // even if message arrival order is not deterministic on the frontend.
        game.sendGameStateToAll();
        return;
      }

    const duplicateAuthInRoom = game.players.some(p => runtimePlayerToUserId.get(p.id) === user.id);
    if (duplicateAuthInRoom) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'User already in room' }));
      return;
    }
    if (userAlreadyInActiveRoom(user.id)) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'User already in another room' }));
      return;
    }

    const success = game.addPlayer(requestedPlayerId, requestedPlayerName, ws, user.coins);
    if (!success) {
      ws.send(
        JSON.stringify({
          type: 'ERROR',
          message: user.coins < game.baseBet
            ? `Insufficient coins for base bet (${game.baseBet})`
            : 'Unable to join room (full or already started)'
        })
      );
      return;
    }

    // Join succeeded; bind socket/session identity now.
    playerId = requestedPlayerId;
    playerName = requestedPlayerName;
    roomId = targetRoomId;
    authUserId = user.id;
    playerRooms.set(requestedPlayerId, targetRoomId);
    runtimePlayerToUserId.set(requestedPlayerId, user.id);
    logger.info('player_joined', {
      roomId: targetRoomId,
      playerId: requestedPlayerId,
      playerName: requestedPlayerName,
      coins: user.coins,
      baseBet: game.baseBet,
      authUserId: user.id
    });
      ws.send(
        JSON.stringify({
          type: 'ROOM_JOINED',
          roomId: targetRoomId,
          playerId: requestedPlayerId,
          playerName: requestedPlayerName,
          baseBet: game.baseBet,
          coins: user.coins,
          reconnected: false
        })
      );
      game.sendGameStateToAll();
    }

  function handleStartGame() {
    if (!roomId) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Not in a room' }));
      return;
    }

    const game = games.get(roomId);
    if (!game) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' }));
      return;
    }

    const success = game.startGame();
    if (!success) {
      ws.send(
        JSON.stringify({
          type: 'ERROR',
          message: 'Unable to start game'
        })
      );
      logger.warn('start_game_failed', { roomId });
      return;
    }
    logger.info('game_started', { roomId });
  }

  function handlePlayerAction(message: any) {
    if (!roomId || !playerId) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Not in a room' }));
      return;
    }

    const game = games.get(roomId);
    if (!game) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' }));
      return;
    }

    // Ignore actions from stale sockets (e.g. after reconnect).
    const currentWs = game.getPlayerWs(playerId);
    if (currentWs && currentWs !== ws) {
      ws.send(
        JSON.stringify({
          type: 'ERROR',
          message: 'This connection is no longer active for the player'
        })
      );
      logger.warn('stale_socket_action_ignored', { roomId, playerId });
      return;
    }

    const action: PlayerAction = {
      type: message.action.type,
      cards: message.action.cards,
      selectedColor: message.action.selectedColor,
      playerId
    };

    logger.debug('player_action', { roomId, playerId, actionType: action.type });
    game.handlePlayerAction(action);
  }

  function handleLeaveRoom() {
    if (!playerId || !roomId) return;

    const timer = disconnectTimers.get(playerId);
    if (timer) clearTimeout(timer);
    disconnectTimers.delete(playerId);

    const game = games.get(roomId);
    if (game) {
      game.removePlayer(playerId);
      if (game.players.length === 0) {
        games.delete(roomId);
      }
    }

    logger.info('player_left', { roomId, playerId, playerName });
    playerRooms.delete(playerId);
    runtimePlayerToUserId.delete(playerId);
    authUserId = null;
    try {
      ws.close();
    } catch {}
  }

  function handleDisconnect(closedWs: WebSocket) {
    if (!playerId || !roomId) return;
    const game = games.get(roomId);
    if (!game) return;

    // If the player's socket has already been replaced (reconnect), ignore this close.
    const currentWs = game.getPlayerWs(playerId);
    if (currentWs && currentWs !== closedWs) return;

    game.disconnectPlayer(playerId);
    logger.info('player_disconnected', { roomId, playerId });

    const existingTimer = disconnectTimers.get(playerId);
    if (existingTimer) clearTimeout(existingTimer);

    const pid = playerId;
    const rid = roomId;
    const timer = setTimeout(() => {
      const actualRoomId = playerRooms.get(pid) || rid;
      const g = games.get(actualRoomId);
      if (g) {
        g.removePlayer(pid);
        if (g.players.length === 0) {
          games.delete(actualRoomId);
        }
      }
      playerRooms.delete(pid);
      disconnectTimers.delete(pid);
      runtimePlayerToUserId.delete(pid);
      logger.info('disconnect_grace_expired_removed', { roomId: actualRoomId, playerId: pid });
    }, DISCONNECT_GRACE_MS);

    disconnectTimers.set(playerId, timer);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UMD game server listening on ${PORT}`);
});
