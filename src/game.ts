/**
 * 游戏核心逻辑模块 - 第1部分
 * 管理整个牌局的状态和规则
 */

import { Card, CardType, CardColor, createDeck, shuffleDeck, cardsAreIdentical, getCardPower } from './card';
import { Player, createPlayer, dealCards, removeCardsFromHand, hasCards, getPlayerPublicInfo, getPlayerPrivateInfo } from './player';
import WebSocket from 'ws';
import { logger } from './logger';

const CLAIM_TIMEOUT_MS = (() => {
  const n = Number(process.env.CLAIM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
})();

const UNO_CALL_TIMEOUT_MS = (() => {
  const n = Number(process.env.UNO_CALL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 3000;
})();

export enum GamePhase {
  WAITING = 'waiting',
  PLAYING = 'playing',
  ENDED = 'ended'
}

export enum HandType {
  SINGLE = 'single',
  PAIR = 'pair',
  TRIPLE = 'triple',
  FULL_HOUSE = 'full_house',
  STRAIGHT = 'straight',
  CONSECUTIVE_PAIRS = 'consecutive_pairs',
  AIRPLANE = 'airplane',
  BOMB = 'bomb'
}

export interface PlayerAction {
  type: 'PLAY_CARDS' | 'DRAW_CARD' | 'CHI' | 'PENG' | 'GANG' | 'DECLARE_UNO' | 'PASS';
  cards?: Card[];
  selectedColor?: string;
  playerId: string;
}

export interface PotentialAction {
  type: 'CHI' | 'PENG' | 'GANG';
  playerId: string;
  cards: Card[];
  targetCard: Card;
}

interface ClaimStep {
  playerId: string;
  actions: PotentialAction[];
}

export class Game {
  players: Player[] = [];
  deck: Card[] = [];
  discardPile: Card[][] = [];
  currentPlayerIndex: number = 0;
  turnDirection: 1 | -1 = 1;
  gamePhase: GamePhase = GamePhase.WAITING;
  lastPlayedHand: Card[] = [];
  lastPlayedHandType: HandType | null = null;
  lastPlayedBy: string | null = null;
  currentColor: CardColor | null = null;
  pendingDrawCount: number = 0;
  pendingDrawType: CardType.DRAW_TWO | CardType.WILD_DRAW_FOUR | null = null;
  pendingEffect: { card: Card; playedById: string; chosenColor: CardColor | null } | null = null;
  pendingActions: PotentialAction[] = [];
  actionTimeout: NodeJS.Timeout | null = null;
  claimQueue: ClaimStep[] = [];
  claimQueueIndex: number = 0;
  roomId: string;
  hasActiveRound: boolean = false;
  passCount: number = 0;
  private unoTimers: Map<string, NodeJS.Timeout> = new Map();
  private unoDeadlineMsByPlayerId: Map<string, number> = new Map();

  constructor(roomId: string) {
    this.roomId = roomId;
    this.deck = shuffleDeck(createDeck());
  }

  private clearUnoTimer(playerId: string): void {
    const timer = this.unoTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
    }
    this.unoTimers.delete(playerId);
    this.unoDeadlineMsByPlayerId.delete(playerId);
  }

  private onPlayerHandChanged(player: Player): void {
    // Reset UNO state when player no longer has exactly 1 card.
    if (player.hand.length !== 1) {
      if (player.hasCalledUno) {
        player.hasCalledUno = false;
      }
      this.clearUnoTimer(player.id);
      return;
    }

    // Exactly 1 card left: require UNO unless already declared.
    if (player.hasCalledUno) {
      this.clearUnoTimer(player.id);
      return;
    }

    // Avoid scheduling multiple timers for the same player.
    if (this.unoTimers.has(player.id)) {
      return;
    }

    const deadlineMs = Date.now() + UNO_CALL_TIMEOUT_MS;
    this.unoDeadlineMsByPlayerId.set(player.id, deadlineMs);

    this.broadcast({
      type: 'UNO_REQUIRED',
      playerId: player.id,
      playerName: player.name,
      timeoutMs: UNO_CALL_TIMEOUT_MS,
      deadlineMs
    });
    logger.info('uno_required', {
      roomId: this.roomId,
      playerId: player.id,
      timeoutMs: UNO_CALL_TIMEOUT_MS
    });

    const timer = setTimeout(() => {
      this.unoTimers.delete(player.id);
      this.unoDeadlineMsByPlayerId.delete(player.id);

      if (this.gamePhase !== GamePhase.PLAYING) return;
      const latest = this.getPlayerById(player.id);
      if (!latest) return;

      if (!latest.hasCalledUno && latest.hand.length === 1) {
        logger.info('uno_penalty', { roomId: this.roomId, playerId: latest.id });
        this.broadcast({
          type: 'UNO_PENALTY',
          playerId: latest.id,
          message: `${latest.name}未宣告UNO，罚摸2张`
        });
        this.drawCardsForPlayer(latest, 2);
        this.sendGameStateToAll();
      }
    }, UNO_CALL_TIMEOUT_MS);

    this.unoTimers.set(player.id, timer);
  }

  private getPlayerById(playerId: string): Player | undefined {
    return this.players.find(p => p.id === playerId);
  }

  getPlayerWs(playerId: string): WebSocket | null {
    return this.getPlayerById(playerId)?.ws ?? null;
  }

  disconnectPlayer(playerId: string): boolean {
    const player = this.getPlayerById(playerId);
    if (!player) return false;
    if (!player.isConnected) return true;

    player.isConnected = false;
    logger.info('player_disconnected', { roomId: this.roomId, playerId });
    this.broadcast({
      type: 'PLAYER_DISCONNECTED',
      playerId
    });
    this.sendGameStateToAll();
    return true;
  }

  reconnectPlayer(playerId: string, ws: WebSocket): boolean {
    const player = this.getPlayerById(playerId);
    if (!player) return false;

    player.ws = ws;
    player.isConnected = true;
    logger.info('player_reconnected', { roomId: this.roomId, playerId });
    this.broadcast({
      type: 'PLAYER_RECONNECTED',
      playerId
    });
    this.sendGameStateToAll();
    return true;
  }

  private isClaimWindowActive(): boolean {
    return !!this.pendingEffect && !!this.actionTimeout && this.claimQueue.length > 0;
  }

  private getCurrentClaimPlayerId(): string | null {
    if (!this.isClaimWindowActive()) return null;
    return this.claimQueue[this.claimQueueIndex]?.playerId ?? null;
  }

  addPlayer(id: string, name: string, ws: WebSocket): boolean {
    if (this.gamePhase !== GamePhase.WAITING) return false;
    if (this.players.length >= 10) return false;
    if (this.players.some(p => p.id === id)) return false;

    const player = createPlayer(id, name, ws);
    this.players.push(player);

    logger.info('player_joined_room', { roomId: this.roomId, playerId: id, playerName: name });
    
    this.broadcast({
      type: 'PLAYER_JOINED',
      player: getPlayerPublicInfo(player),
      playerCount: this.players.length
    });

    return true;
  }

  removePlayer(playerId: string): void {
    this.clearUnoTimer(playerId);
    const index = this.players.findIndex(p => p.id === playerId);
    if (index !== -1) {
      const wasCurrent = index === this.currentPlayerIndex;
      this.players.splice(index, 1);

      logger.info('player_left_room', { roomId: this.roomId, playerId });

      if (this.currentPlayerIndex > index) {
        this.currentPlayerIndex--;
      }
      if (this.currentPlayerIndex >= this.players.length) {
        this.currentPlayerIndex = 0;
      }

      this.broadcast({
        type: 'PLAYER_LEFT',
        playerId,
        playerCount: this.players.length
      });

      if (this.gamePhase === GamePhase.PLAYING) {
        if (this.players.length === 1) {
          this.endGame(this.players[0].id);
          return;
        }
        if (this.players.length === 0) {
          this.gamePhase = GamePhase.ENDED;
          return;
        }

        if (wasCurrent) {
          this.broadcast({
            type: 'TURN_CHANGED',
            currentPlayerId: this.players[this.currentPlayerIndex]?.id
          });
        }
        this.sendGameStateToAll();
      }
    }
  }

  startGame(): boolean {
    if (this.players.length < 2) return false;
    if (this.gamePhase !== GamePhase.WAITING) return false;

    for (const player of this.players) {
      const cards = this.deck.splice(0, 13);
      dealCards(player, cards);
    }

    this.currentPlayerIndex = Math.floor(Math.random() * this.players.length);
    this.gamePhase = GamePhase.PLAYING;

    logger.info('game_started', { roomId: this.roomId, playerCount: this.players.length });
    this.hasActiveRound = false;

    this.broadcast({
      type: 'GAME_STARTED',
      currentPlayerId: this.players[this.currentPlayerIndex].id
    });

    this.sendGameStateToAll();
    return true;
  }

  handlePlayerAction(action: PlayerAction): void {
    logger.info('player_action', {
      roomId: this.roomId,
      playerId: action.playerId,
      type: action.type,
      cardCount: action.cards?.length ?? 0
    });
    const player = this.players.find(p => p.id === action.playerId);
    if (!player) {
      this.sendToPlayer(action.playerId, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '玩家不存在'
      });
      return;
    }

    // During the CHI/PENG/GANG claim window, only the currently prompted player may respond,
    // and only with CHI/PENG/GANG. Everyone else must wait.
    if (this.isClaimWindowActive()) {
      const claimPlayerId = this.getCurrentClaimPlayerId();
      const isClaimAction = action.type === 'CHI' || action.type === 'PENG' || action.type === 'GANG';
      if (!claimPlayerId || action.playerId !== claimPlayerId || !isClaimAction) {
        this.sendToPlayer(action.playerId, {
          type: 'ACTION_VALIDATION',
          isValid: false,
          message: 'Waiting for CHI/PENG/GANG decision'
        });
        return;
      }
    }

    switch (action.type) {
      case 'PLAY_CARDS':
        this.handlePlayCards(player, action.cards || [], action.selectedColor);
        break;
      case 'DRAW_CARD':
        this.handleDrawCard(player);
        break;
      case 'CHI':
        this.handleChi(player, action.cards || []);
        break;
      case 'PENG':
        this.handlePeng(player);
        break;
      case 'GANG':
        this.handleGang(player);
        break;
      case 'DECLARE_UNO':
        this.handleDeclareUno(player);
        break;
      case 'PASS':
        this.handlePass(player);
        break;
    }
  }

  private handlePlayCards(player: Player, cards: Card[], selectedColor?: string): void {
    if (this.players[this.currentPlayerIndex].id !== player.id) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '还没轮到你出牌'
      });
      return;
    }

    if (player.isSkipped) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '你被跳过了'
      });
      player.isSkipped = false;
      this.nextTurn();
      return;
    }

    if (!hasCards(player, cards)) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '你没有这些牌'
      });
      return;
    }

    const handType = this.identifyHandType(cards);
    if (!handType) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '无效的牌型'
      });
      return;
    }

      const chosenColor = this.parseSelectedColor(selectedColor);
      const hasWild = cards.some(c => c.type === CardType.WILD || c.type === CardType.WILD_DRAW_FOUR);
      if (hasWild && !chosenColor) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '出万能牌时必须选择变色后的颜色'
      });
        return;
      }

      logger.info('cards_played', {
        roomId: this.roomId,
        playerId: player.id,
        handType,
        cards: cards.map(c => ({ color: c.color, type: c.type, value: c.value })),
        chosenColor: chosenColor ?? null,
        pendingDrawCountBefore: this.pendingDrawCount,
        pendingDrawTypeBefore: this.pendingDrawType
      });
      // +2/+4 stacking: if there is a pending draw penalty, the current player must respond with +2/+4 or a bomb,
      // otherwise they must accept the penalty via PASS/DRAW_CARD.
      if (this.pendingDrawCount > 0) {
      const isBomb = handType === HandType.BOMB;
      const isDrawResponse =
        handType === HandType.SINGLE &&
        cards.length === 1 &&
        (this.pendingDrawType === CardType.WILD_DRAW_FOUR
          ? cards[0].type === CardType.WILD_DRAW_FOUR
          : cards[0].type === CardType.DRAW_TWO || cards[0].type === CardType.WILD_DRAW_FOUR);

      if (!isBomb && !isDrawResponse) {
        const allowText =
          this.pendingDrawType === CardType.WILD_DRAW_FOUR ? '+4' : '+2/+4';
        this.sendToPlayer(player.id, {
          type: 'ACTION_VALIDATION',
          isValid: false,
          message: `链有加牌惩罚：可接${allowText}或出炸弹，或PASS接受罚牌`
        });
        return;
      }
    }

    if (this.pendingDrawCount === 0 && !this.isValidPlay(cards, this.lastPlayedHand, handType)) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '出牌不符合规则'
      });
      return;
    }

    removeCardsFromHand(player, cards);
    this.lastPlayedHand = cards;
    this.lastPlayedHandType = handType;
    this.lastPlayedBy = player.id;
    this.discardPile.push(cards);
    this.hasActiveRound = true;
    this.passCount = 0;

    if (this.pendingDrawCount > 0 && handType === HandType.BOMB) {
      // Bomb overrides the pending draw chain.
      this.pendingDrawCount = 0;
      this.pendingDrawType = null;
    }

    if (handType !== HandType.SINGLE) {
      if (
        handType === HandType.STRAIGHT ||
        handType === HandType.CONSECUTIVE_PAIRS ||
        handType === HandType.AIRPLANE ||
        handType === HandType.FULL_HOUSE
      ) {
        this.currentColor = null;
      } else if (cards.length > 0 && cards[0].color !== CardColor.WILD) {
        this.currentColor = cards[0].color;
      }
    }

    this.broadcast({
      type: 'CARDS_PLAYED',
      playerId: player.id,
      cards: cards,
      handType: handType,
      remainingCards: player.hand.length,
      chosenColor: chosenColor
    });

      if (player.hand.length === 0) {
        logger.info('player_won', { roomId: this.roomId, playerId: player.id });
        this.endGame(player.id);
        return;
      }

    this.onPlayerHandChanged(player);

    if (handType === HandType.SINGLE) {
      // Give other players a chance to CHI/PENG/GANG before this card's effect triggers.
      this.pendingEffect = { card: cards[0], playedById: player.id, chosenColor };
      const hasClaims = this.findPotentialActions(cards[0], player);
      if (!hasClaims) {
        this.resolvePendingEffectNoClaim();
      }
      return;
    }

    // For non-single hands, apply effects once (if any) and advance the turn.
    this.applyCardEffects([cards[0]], player, chosenColor);
    this.nextTurn();
  }

  /**
   * 识别牌型
   */
  private parseSelectedColor(selectedColor?: string): CardColor | null {
    if (!selectedColor) return null;
    const normalized = selectedColor.trim().toUpperCase();

    switch (normalized) {
      case 'RED':
        return CardColor.RED;
      case 'YELLOW':
        return CardColor.YELLOW;
      case 'BLUE':
        return CardColor.BLUE;
      case 'GREEN':
        return CardColor.GREEN;
      default:
        break;
    }

    const values = Object.values(CardColor) as unknown as string[];
    if (values.includes(selectedColor)) return selectedColor as unknown as CardColor;
    return null;
  }

  private resolvePendingEffectNoClaim(): void {
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }

    this.pendingActions = [];
    this.claimQueue = [];
    this.claimQueueIndex = 0;

    const pending = this.pendingEffect;
    if (!pending) return;
    this.pendingEffect = null;

    const playedByIndex = this.players.findIndex(p => p.id === pending.playedById);
    if (playedByIndex >= 0) {
      this.currentPlayerIndex = playedByIndex;
    }

    if (pending.card.type !== CardType.WILD && pending.card.type !== CardType.WILD_DRAW_FOUR) {
      this.currentColor = pending.card.color;
    }

    this.applyCardEffects([pending.card], this.players[this.currentPlayerIndex], pending.chosenColor);
    this.nextTurn();
  }

  private playerCanRespondToPendingDraw(player: Player): boolean {
    if (this.pendingDrawType === CardType.WILD_DRAW_FOUR) {
      if (player.hand.some(c => c.type === CardType.WILD_DRAW_FOUR)) return true;
    } else {
      if (player.hand.some(c => c.type === CardType.DRAW_TWO || c.type === CardType.WILD_DRAW_FOUR)) return true;
    }

    // Bomb response: 4+ identical cards (same color/type/value).
    const counts = new Map<string, number>();
    for (const c of player.hand) {
      const key = `${c.color}|${c.type}|${c.value}`;
      const next = (counts.get(key) || 0) + 1;
      if (next >= 4) return true;
      counts.set(key, next);
    }
    return false;
  }

  private promptNextClaimCandidate(): void {
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }

    if (this.claimQueueIndex >= this.claimQueue.length) {
      this.pendingActions = [];
      this.claimQueue = [];
      this.claimQueueIndex = 0;
      this.resolvePendingEffectNoClaim();
      return;
    }

    const step = this.claimQueue[this.claimQueueIndex];
    this.pendingActions = step.actions;

    const targetCard = step.actions[0]?.targetCard;
    const type = step.actions[0]?.type;

    this.sendToPlayer(step.playerId, {
      type: 'POTENTIAL_ACTION',
      actions: type ? [type] : [],
      targetCard,
      candidates: step.actions.map(a => ({ type: a.type, cards: a.cards })),
      timeoutMs: CLAIM_TIMEOUT_MS
    });

    this.actionTimeout = setTimeout(() => {
      this.pendingActions = [];
      this.claimQueueIndex++;
      this.promptNextClaimCandidate();
    }, CLAIM_TIMEOUT_MS);
  }

  private removeCardFromDiscardPile(cardId: string): void {
    for (let i = this.discardPile.length - 1; i >= 0; i--) {
      const group = this.discardPile[i];
      const idx = group.findIndex(c => c.id === cardId);
      if (idx === -1) continue;
      group.splice(idx, 1);
      if (group.length === 0) {
        this.discardPile.splice(i, 1);
      }
      return;
    }
  }

  private startNewRoundWithLeader(leaderId: string): void {
    this.hasActiveRound = false;
    this.passCount = 0;
    this.lastPlayedHand = [];
    this.lastPlayedHandType = null;
    this.lastPlayedBy = null;
    this.currentColor = null;
    this.pendingDrawCount = 0;
    this.pendingDrawType = null;
    this.pendingEffect = null;

    const leaderIndex = this.players.findIndex(p => p.id === leaderId);
    if (leaderIndex >= 0) {
      this.currentPlayerIndex = leaderIndex;
    }

    this.broadcast({
      type: 'NEW_ROUND',
      leadPlayerId: leaderId,
      message: 'Claimed discard; new round starts'
    });

    this.broadcast({
      type: 'TURN_CHANGED',
      currentPlayerId: this.players[this.currentPlayerIndex]?.id
    });
  }

  private identifyHandType(cards: Card[]): HandType | null {
    if (cards.length === 0) return null;

    if (cards.length === 1) return HandType.SINGLE;

    // 检查是否所有牌完全相同
    const allSame = cards.every(c => cardsAreIdentical(c, cards[0]));
    
    if (allSame) {
      // Disallow forming pairs/triples with special UNO cards (+2/+4/skip/reverse/wild).
      // They must be played as SINGLE (UNO style). Bombs (4+) are still allowed.
      if (cards.length === 2 || cards.length === 3) {
        if (cards[0].type !== CardType.NUMBER) return null;
        if (cards.length === 2) return HandType.PAIR;
        return HandType.TRIPLE;
      }
      if (cards.length >= 4) return HandType.BOMB;
    }

    if (cards.length === 5 && this.isFullHouse(cards)) {
      return HandType.FULL_HOUSE;
    }

    // 检查顺子（5张以上连续数字）
    if (cards.length >= 5 && this.isStraight(cards)) {
      return HandType.STRAIGHT;
    }

    // 检查连对（3对以上连续）
    if (cards.length >= 6 && cards.length % 2 === 0 && this.isConsecutivePairs(cards)) {
      return HandType.CONSECUTIVE_PAIRS;
    }

    // 检查飞机（2组以上连续三张）
    if (cards.length >= 6 && cards.length % 3 === 0 && this.isAirplane(cards)) {
      return HandType.AIRPLANE;
    }

    return null;
  }

  private isStraight(cards: Card[]): boolean {
    const numbers = cards
      .filter(c => c.type === CardType.NUMBER)
      .map(c => parseInt(c.value))
      .sort((a, b) => a - b);
    
    if (numbers.length !== cards.length) return false;
    
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] !== numbers[i - 1] + 1) return false;
    }
    return true;
  }

  private isConsecutivePairs(cards: Card[]): boolean {
    const counts = new Map<number, number>();

    for (const card of cards) {
      if (card.type !== CardType.NUMBER) return false;
      const value = parseInt(card.value);
      counts.set(value, (counts.get(value) || 0) + 1);
    }

    const values = Array.from(counts.keys()).sort((a, b) => a - b);
    for (const v of values) {
      if (counts.get(v) !== 2) return false;
    }

    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1] + 1) return false;
    }

    return values.length * 2 === cards.length;
  }

  private isAirplane(cards: Card[]): boolean {
    const counts = new Map<number, number>();

    for (const card of cards) {
      if (card.type !== CardType.NUMBER) return false;
      const value = parseInt(card.value);
      counts.set(value, (counts.get(value) || 0) + 1);
    }

    const values = Array.from(counts.keys()).sort((a, b) => a - b);
    for (const v of values) {
      if (counts.get(v) !== 3) return false;
    }

    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1] + 1) return false;
    }

    return values.length * 3 === cards.length;
  }

  private isFullHouse(cards: Card[]): boolean {
    const counts = new Map<number, number>();

    for (const card of cards) {
      if (card.type !== CardType.NUMBER) return false;
      const value = parseInt(card.value);
      counts.set(value, (counts.get(value) || 0) + 1);
    }

    if (counts.size !== 2) return false;
    const sortedCounts = Array.from(counts.values()).sort((a, b) => a - b);
    return sortedCounts[0] === 2 && sortedCounts[1] === 3;
  }

  /**
   * 核心验证函数：判断出牌是否合法
   */

  isValidPlay(playedCards: Card[], lastCards: Card[], handType: HandType): boolean {
    // 如果是第一手牌或者上一轮所有人都pass了，可以出任意牌型
    if (!this.hasActiveRound || lastCards.length === 0) {
      return true;
    }

    // 炸弹可以压任何牌
    if (handType === HandType.BOMB) {
      if (this.lastPlayedHandType !== HandType.BOMB) return true;
      return this.compareBombs(playedCards, lastCards);
    }

    const lastType = this.lastPlayedHandType;
    if (!lastType) return true;

    // UNO-style phase (single / pair / triple): allow switching into other hand types,
    // as long as the played hand matches the current effective color (or is wild/bomb handled above).
    if (lastType === HandType.SINGLE || lastType === HandType.PAIR || lastType === HandType.TRIPLE) {
      const activeColor =
        this.currentColor ?? (lastCards[0].color !== CardColor.WILD ? lastCards[0].color : null);

      const allMatchActiveColor =
        !!activeColor &&
        playedCards.length > 0 &&
        playedCards.every(c => c.color !== CardColor.WILD && c.color === activeColor);

      switch (handType) {
        case HandType.SINGLE:
          return this.isValidSinglePlay(playedCards[0], lastCards[0]);
        case HandType.PAIR:
        case HandType.TRIPLE:
          return this.compareGroups(playedCards, lastCards);
        case HandType.FULL_HOUSE:
        case HandType.STRAIGHT:
        case HandType.CONSECUTIVE_PAIRS:
        case HandType.AIRPLANE:
          return allMatchActiveColor;
        default:
          return false;
      }
    }

    // Combo rounds: must match the same hand type (bombs handled above).
    if (lastType !== handType) {
      return false;
    }

    switch (handType) {
      case HandType.FULL_HOUSE:
        return playedCards.length === lastCards.length;
      case HandType.STRAIGHT:
      case HandType.CONSECUTIVE_PAIRS:
      case HandType.AIRPLANE:
        return this.compareSequences(playedCards, lastCards);
      default:
        return false;
    }

    // 牌型必须一致
    if (this.lastPlayedHandType !== handType) {
      return false;
    }

    // 根据牌型比较大小
    switch (handType) {
      case HandType.SINGLE:
        return this.isValidSinglePlay(playedCards[0], lastCards[0]);
      case HandType.PAIR:
      case HandType.TRIPLE:
        return this.compareGroups(playedCards, lastCards);
      case HandType.FULL_HOUSE:
        return playedCards.length === lastCards.length;
      case HandType.STRAIGHT:
      case HandType.CONSECUTIVE_PAIRS:
      case HandType.AIRPLANE:
        return this.compareSequences(playedCards, lastCards);
      default:
        return false;
    }
  }

  /**
   * 比较单张牌
   * 规则：同色且更大 或 异色且等大
   */
  private compareSingleCards(played: Card, last: Card): boolean {
    const playedPower = getCardPower(played);
    const lastPower = getCardPower(last);

    // 同色：必须更大
    if (played.color === last.color) {
      return playedPower > lastPower;
    }

    // 异色：必须等大（对于功能牌，等大指同类型）
    if (played.type !== CardType.NUMBER && last.type !== CardType.NUMBER) {
      return played.type === last.type;
    }

    // 数字牌异色等大
    return playedPower === lastPower;
  }

  /**
   * 比较对子/三张
   */
  private isValidSinglePlay(played: Card, last: Card): boolean {
    // UNO rules (plus bombs handled at hand-type level):
    // - Wild / +4 can be played on anything
    // - Otherwise: match current color OR match symbol/value
    // - After a wild, the "current color" is the chosen color

    if (played.type === CardType.WILD || played.type === CardType.WILD_DRAW_FOUR) {
      return true;
    }

    const activeColor = this.currentColor ?? (last.color !== CardColor.WILD ? last.color : null);

    // If the last card is a wild, only the chosen color (or another wild handled above) is allowed.
    if (last.type === CardType.WILD || last.type === CardType.WILD_DRAW_FOUR) {
      return !!activeColor && played.color === activeColor;
    }

    // Match color: any card allowed.
    if (activeColor && played.color === activeColor) {
      return true;
    }

    // Match value/symbol.
    if (last.type === CardType.NUMBER) {
      return played.type === CardType.NUMBER && played.value === last.value;
    }

    return played.type === last.type;
  }

  private isValidGroupPlay(played: Card, last: Card): boolean {
    // Group hands (PAIR / TRIPLE): follow the active color only (plus wilds).
    // This matches "state is YELLOW => must play YELLOW group".
    if (played.type === CardType.WILD || played.type === CardType.WILD_DRAW_FOUR) {
      return true;
    }

    const activeColor = this.currentColor ?? (last.color !== CardColor.WILD ? last.color : null);
    if (!activeColor) return false;
    return played.color === activeColor;
  }

  private compareGroups(played: Card[], last: Card[]): boolean {
    return this.isValidGroupPlay(played[0], last[0]);
  }

  /**
   * 比较顺子/连对/飞机
   */
  private compareSequences(played: Card[], last: Card[]): boolean {
    // For these combo hands, only the format (hand type + length) matters.
    return played.length === last.length;
  }

  /**
   * 比较炸弹
   */
  private compareBombs(played: Card[], last: Card[]): boolean {
    if (played.length !== last.length) {
      return played.length > last.length;
    }

    const playedPower = getCardPower(played[0]);
    const lastPower = getCardPower(last[0]);
    return playedPower > lastPower;
  }

  /**
   * 应用卡牌效果
   */
  private applyCardEffects(cards: Card[], player: Player, chosenColor: CardColor | null): void {
    for (const card of cards) {
      switch (card.type) {
        case CardType.SKIP: {
          const nextIndex = this.getNextPlayerIndex();
          this.players[nextIndex].isSkipped = true;
          this.broadcast({
            type: 'PLAYER_SKIPPED',
            playerId: this.players[nextIndex].id
          });
          logger.info('effect_skip', {
            roomId: this.roomId,
            by: player.id,
            target: this.players[nextIndex].id
          });
          break;
        }

        case CardType.REVERSE: {
          this.turnDirection *= -1;
          this.broadcast({
            type: 'DIRECTION_REVERSED',
            newDirection: this.turnDirection
          });
          logger.info('effect_reverse', {
            roomId: this.roomId,
            by: player.id,
            direction: this.turnDirection
          });

          // UNO: in 2-player mode, Reverse acts like Skip.
          if (this.players.length === 2) {
            const nextIndex = this.getNextPlayerIndex();
            this.players[nextIndex].isSkipped = true;
            this.broadcast({
              type: 'PLAYER_SKIPPED',
              playerId: this.players[nextIndex].id
            });
            logger.info('effect_reverse_as_skip_2p', {
              roomId: this.roomId,
              by: player.id,
              target: this.players[nextIndex].id
            });
          }
          break;
        }

        case CardType.DRAW_TWO: {
          // UNO stacking: accumulate the draw penalty; the next player may respond with +2/+4 or a bomb.
          this.pendingDrawCount += 2;
          this.pendingDrawType = CardType.DRAW_TWO;
          this.broadcast({
            type: 'PENDING_DRAW_UPDATED',
            count: this.pendingDrawCount
          });
          logger.info('effect_draw2_pending', {
            roomId: this.roomId,
            by: player.id,
            pendingDrawCount: this.pendingDrawCount,
            pendingDrawType: this.pendingDrawType
          });
          break;
        }

        case CardType.WILD: {
          if (chosenColor) {
            this.currentColor = chosenColor;
            this.broadcast({
              type: 'COLOR_CHANGED',
              color: chosenColor
            });
            logger.info('effect_wild_color', { roomId: this.roomId, by: player.id, color: chosenColor });
          }
          break;
        }

        case CardType.WILD_DRAW_FOUR: {
          if (chosenColor) {
            this.currentColor = chosenColor;
            this.broadcast({
              type: 'COLOR_CHANGED',
              color: chosenColor
            });
            logger.info('effect_wild_draw4_color', { roomId: this.roomId, by: player.id, color: chosenColor });
          }
          // UNO stacking: accumulate the draw penalty; the next player may respond with +2/+4 or a bomb.
          this.pendingDrawCount += 4;
          this.pendingDrawType = CardType.WILD_DRAW_FOUR;
          this.broadcast({
            type: 'PENDING_DRAW_UPDATED',
            count: this.pendingDrawCount
          });
          logger.info('effect_draw4_pending', {
            roomId: this.roomId,
            by: player.id,
            pendingDrawCount: this.pendingDrawCount,
            pendingDrawType: this.pendingDrawType
          });
          break;
        }
      }
    }
  }

  private findPotentialActions(card: Card, playedBy: Player): boolean {
    this.pendingActions = [];
    this.claimQueue = [];
    this.claimQueueIndex = 0;

    const startIndex = this.getNextPlayerIndex();
    const order: number[] = [];
    for (let k = 0; k < this.players.length - 1; k++) {
      const idx = (startIndex + k * this.turnDirection + this.players.length) % this.players.length;
      order.push(idx);
    }

    const gangByPlayer = new Map<string, PotentialAction>();
    const pengByPlayer = new Map<string, PotentialAction>();
    const chiByPlayer = new Map<string, PotentialAction[]>();

    for (const idx of order) {
      const player = this.players[idx];
      if (player.id === playedBy.id) continue;

      const identicalInHand = player.hand.filter(c => cardsAreIdentical(c, card));
      if (identicalInHand.length >= 3) {
        gangByPlayer.set(player.id, {
          type: 'GANG',
          playerId: player.id,
          cards: identicalInHand.slice(0, 3),
          targetCard: card
        });
        continue;
      }

      if (identicalInHand.length >= 2) {
        pengByPlayer.set(player.id, {
          type: 'PENG',
          playerId: player.id,
          cards: identicalInHand.slice(0, 2),
          targetCard: card
        });
      }
    }

    // CHI: only the next player can CHI (lowest priority).
    const nextPlayer = this.players[startIndex];
    if (nextPlayer && nextPlayer.id !== playedBy.id && card.type === CardType.NUMBER) {
      const cardValue = parseInt(card.value);
      const sameColorCards = nextPlayer.hand.filter(c => c.color === card.color && c.type === CardType.NUMBER);
      const values = sameColorCards.map(c => parseInt(c.value));

      const chiOptions: PotentialAction[] = [];

      if (values.includes(cardValue - 1) && values.includes(cardValue - 2)) {
        const chiCards = [
          sameColorCards.find(c => parseInt(c.value) === cardValue - 2)!,
          sameColorCards.find(c => parseInt(c.value) === cardValue - 1)!
        ];
        chiOptions.push({
          type: 'CHI',
          playerId: nextPlayer.id,
          cards: chiCards,
          targetCard: card
        });
      }

      if (values.includes(cardValue - 1) && values.includes(cardValue + 1)) {
        const chiCards = [
          sameColorCards.find(c => parseInt(c.value) === cardValue - 1)!,
          sameColorCards.find(c => parseInt(c.value) === cardValue + 1)!
        ];
        chiOptions.push({
          type: 'CHI',
          playerId: nextPlayer.id,
          cards: chiCards,
          targetCard: card
        });
      }

      if (values.includes(cardValue + 1) && values.includes(cardValue + 2)) {
        const chiCards = [
          sameColorCards.find(c => parseInt(c.value) === cardValue + 1)!,
          sameColorCards.find(c => parseInt(c.value) === cardValue + 2)!
        ];
        chiOptions.push({
          type: 'CHI',
          playerId: nextPlayer.id,
          cards: chiCards,
          targetCard: card
        });
      }

      if (chiOptions.length > 0) {
        chiByPlayer.set(nextPlayer.id, chiOptions);
      }
    }

    // Priority: GANG > PENG > CHI; within each, ask in turn order (next player, then next...).
    for (const idx of order) {
      const playerId = this.players[idx]?.id;
      if (!playerId) continue;
      const action = gangByPlayer.get(playerId);
      if (!action) continue;
      this.claimQueue.push({ playerId, actions: [action] });
    }

    for (const idx of order) {
      const playerId = this.players[idx]?.id;
      if (!playerId) continue;
      if (gangByPlayer.has(playerId)) continue;
      const action = pengByPlayer.get(playerId);
      if (!action) continue;
      this.claimQueue.push({ playerId, actions: [action] });
    }

    for (const idx of order) {
      const playerId = this.players[idx]?.id;
      if (!playerId) continue;
      if (gangByPlayer.has(playerId) || pengByPlayer.has(playerId)) continue;
      const actions = chiByPlayer.get(playerId);
      if (!actions || actions.length === 0) continue;
      this.claimQueue.push({ playerId, actions });
    }

    if (this.claimQueue.length === 0) {
      return false;
    }

    this.promptNextClaimCandidate();
    return true;
  }

  private handleChi(player: Player, cards: Card[]): void {
    const chiOptions = this.pendingActions.filter(a => a.playerId === player.id && a.type === 'CHI');

    if (chiOptions.length === 0) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '无法吃牌（窗口已过期或当前不可吃）'
      });
      return;
    }

    // 清除超时
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }

    const provided = cards || [];

    const matchesById = (candidate: Card[], selected: Card[]) => {
      if (candidate.length !== selected.length) return false;
      return candidate.every(c => selected.some(s => s.id && s.id === c.id));
    };

    const matchesByIdentity = (candidate: Card[], selected: Card[]) => {
      if (candidate.length !== selected.length) return false;
      const used = new Array(selected.length).fill(false);
      for (const c of candidate) {
        let found = false;
        for (let i = 0; i < selected.length; i++) {
          if (used[i]) continue;
          if (cardsAreIdentical(c, selected[i])) {
            used[i] = true;
            found = true;
            break;
          }
        }
        if (!found) return false;
      }
      return true;
    };

    let chiCandidate: PotentialAction | undefined;
    if (provided.length === 0) {
      // If the client didn't specify which 2 cards to use for CHI, auto-select only when unambiguous.
      if (chiOptions.length === 1) {
        chiCandidate = chiOptions[0];
      } else {
        this.sendToPlayer(player.id, {
          type: 'ACTION_VALIDATION',
          isValid: false,
          message: '吃牌需要选择两张牌（前端需传 cards）'
        });
        return;
      }
    } else {
      chiCandidate =
        chiOptions.find(a => matchesById(a.cards, provided)) ??
        chiOptions.find(a => matchesByIdentity(a.cards, provided));

      if (!chiCandidate) {
        this.sendToPlayer(player.id, {
          type: 'ACTION_VALIDATION',
          isValid: false,
          message: '无法吃牌（选择的组合不在候选项中）'
        });
        return;
      }
    }

    if (!hasCards(player, chiCandidate.cards)) {
      logger.warn('chi_invalid_missing_cards', {
        roomId: this.roomId,
        playerId: player.id,
        provided: provided.map(c => ({ id: c.id, color: c.color, type: c.type, value: c.value })),
        candidate: chiCandidate.cards.map(c => ({ id: c.id, color: c.color, type: c.type, value: c.value }))
      });
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '你没有这些牌'
      });
      return;
    }

    // 执行吃牌
    const removed = removeCardsFromHand(player, chiCandidate.cards);
    if (!removed) {
      logger.error('chi_failed_remove_cards', {
        roomId: this.roomId,
        playerId: player.id,
        candidate: chiCandidate.cards.map(c => ({ id: c.id, color: c.color, type: c.type, value: c.value }))
      });
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '无法吃牌（服务器状态异常：移除手牌失败）'
      });
      return;
    }

    const meldedSet = [...chiCandidate.cards, chiCandidate.targetCard].sort((a, b) => {
      const av = Number(a.value);
      const bv = Number(b.value);
      if (Number.isFinite(av) && Number.isFinite(bv)) return av - bv;
      return 0;
    });
    player.meldedCards.push(meldedSet);

      this.broadcast({
        type: 'CHI_PERFORMED',
        playerId: player.id,
        cards: meldedSet
      });
      logger.info('chi_performed', {
        roomId: this.roomId,
        playerId: player.id,
        target: { color: chiCandidate.targetCard.color, type: chiCandidate.targetCard.type, value: chiCandidate.targetCard.value },
        meld: meldedSet.map(c => ({ color: c.color, type: c.type, value: c.value }))
      });

    this.pendingActions = [];
    this.pendingEffect = null;
    this.claimQueue = [];
    this.claimQueueIndex = 0;
    this.removeCardFromDiscardPile(chiCandidate.targetCard.id);
    this.startNewRoundWithLeader(player.id);
    this.onPlayerHandChanged(player);
    this.sendGameStateToAll();
  }

  /**
   * 处理碰牌
   */
  private handlePeng(player: Player): void {
    const action = this.pendingActions.find(a => 
      a.playerId === player.id && a.type === 'PENG'
    );

    if (!action) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '无法碰牌'
      });
      return;
    }

    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }

    if (!hasCards(player, action.cards)) {
      logger.warn('peng_invalid_missing_cards', {
        roomId: this.roomId,
        playerId: player.id,
        candidate: action.cards.map(c => ({ id: c.id, color: c.color, type: c.type, value: c.value }))
      });
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '你没有这些牌'
      });
      return;
    }

    const removed = removeCardsFromHand(player, action.cards);
    if (!removed) {
      logger.error('peng_failed_remove_cards', {
        roomId: this.roomId,
        playerId: player.id,
        candidate: action.cards.map(c => ({ id: c.id, color: c.color, type: c.type, value: c.value }))
      });
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '无法碰牌（服务器状态异常：移除手牌失败）'
      });
      return;
    }
    const meldedSet = [...action.cards, action.targetCard];
    player.meldedCards.push(meldedSet);

      this.broadcast({
        type: 'PENG_PERFORMED',
        playerId: player.id,
        cards: meldedSet
      });
      logger.info('peng_performed', {
        roomId: this.roomId,
        playerId: player.id,
        target: { color: action.targetCard.color, type: action.targetCard.type, value: action.targetCard.value }
      });

    // 处理+2或+4的碰
    if (action.targetCard.type === CardType.DRAW_TWO) {
      for (const p of this.players) {
        if (p.id !== player.id) {
          this.drawCardsForPlayer(p, 2);
        }
      }
    } else if (action.targetCard.type === CardType.WILD_DRAW_FOUR) {
      for (const p of this.players) {
        if (p.id !== player.id) {
          this.drawCardsForPlayer(p, 4);
        }
      }
    }

    this.pendingActions = [];
    this.pendingEffect = null;
    this.claimQueue = [];
    this.claimQueueIndex = 0;
    this.removeCardFromDiscardPile(action.targetCard.id);
    this.startNewRoundWithLeader(player.id);
    this.onPlayerHandChanged(player);
    this.sendGameStateToAll();
  }

  /**
   * 处理杠牌
   */
  private handleGang(player: Player): void {
    const action = this.pendingActions.find(a => 
      a.playerId === player.id && a.type === 'GANG'
    );

    if (!action) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '无法杠牌'
      });
      return;
    }

    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }

    if (!hasCards(player, action.cards)) {
      logger.warn('gang_invalid_missing_cards', {
        roomId: this.roomId,
        playerId: player.id,
        candidate: action.cards.map(c => ({ id: c.id, color: c.color, type: c.type, value: c.value }))
      });
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '你没有这些牌'
      });
      return;
    }

    const removed = removeCardsFromHand(player, action.cards);
    if (!removed) {
      logger.error('gang_failed_remove_cards', {
        roomId: this.roomId,
        playerId: player.id,
        candidate: action.cards.map(c => ({ id: c.id, color: c.color, type: c.type, value: c.value }))
      });
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '无法杠牌（服务器状态异常：移除手牌失败）'
      });
      return;
    }
    const meldedSet = [...action.cards, action.targetCard];
    player.meldedCards.push(meldedSet);

      this.broadcast({
        type: 'GANG_PERFORMED',
        playerId: player.id,
        cards: meldedSet
      });
      logger.info('gang_performed', {
        roomId: this.roomId,
        playerId: player.id,
        target: { color: action.targetCard.color, type: action.targetCard.type, value: action.targetCard.value }
      });

    // 处理+2或+4的杠
    if (action.targetCard.type === CardType.DRAW_TWO) {
      for (const p of this.players) {
        if (p.id !== player.id) {
          this.drawCardsForPlayer(p, 2);
        }
      }
    } else if (action.targetCard.type === CardType.WILD_DRAW_FOUR) {
      for (const p of this.players) {
        if (p.id !== player.id) {
          this.drawCardsForPlayer(p, 4);
        }
      }
    }

    this.pendingActions = [];
    this.pendingEffect = null;
    this.claimQueue = [];
    this.claimQueueIndex = 0;
    this.removeCardFromDiscardPile(action.targetCard.id);
    this.drawCardsForPlayer(player, 1);
    this.startNewRoundWithLeader(player.id);
    this.sendGameStateToAll();
  }

  /**
   * 处理摸牌
   */
  private handleDrawCard(player: Player): void {
    if (this.players[this.currentPlayerIndex].id !== player.id) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '还没轮到你'
      });
      return;
    }

      // If there is a pending +2/+4 chain, DRAW_CARD means "accept the penalty".
      if (this.pendingDrawCount > 0) {
        const count = this.pendingDrawCount;
        this.pendingDrawCount = 0;
        this.pendingDrawType = null;
        logger.info('draw_penalty_accepted', { roomId: this.roomId, playerId: player.id, count });
        this.drawCardsForPlayer(player, count);
        this.broadcast({
          type: 'DRAW_PENALTY_ACCEPTED',
          playerId: player.id,
        count
      });
      this.nextTurn();
      return;
      }

      logger.info('draw_card', { roomId: this.roomId, playerId: player.id, count: 1 });
      this.drawCardsForPlayer(player, 1);
      this.nextTurn();
    }

  /**
   * 处理Pass
   * 规则：Pass时必须摸一张牌，然后回合结束
   */
  private handlePass(player: Player): void {
    if (this.players[this.currentPlayerIndex].id !== player.id) {
      return;
    }

    if (player.isSkipped) {
      player.isSkipped = false;
      this.nextTurn();
      return;
    }

      // If there is a pending +2/+4 chain, PASS means "accept the penalty".
      if (this.pendingDrawCount > 0) {
        const count = this.pendingDrawCount;
        this.pendingDrawCount = 0;
        this.pendingDrawType = null;
        logger.info('draw_penalty_accepted', { roomId: this.roomId, playerId: player.id, count });
        this.drawCardsForPlayer(player, count);
        this.broadcast({
          type: 'DRAW_PENALTY_ACCEPTED',
          playerId: player.id,
        count
      });
      this.broadcast({
        type: 'PLAYER_PASSED',
        playerId: player.id
      });
      this.nextTurn();
      return;
      }

      logger.info('pass', { roomId: this.roomId, playerId: player.id });
      this.drawCardsForPlayer(player, 1);

    this.broadcast({
      type: 'PLAYER_PASSED',
      playerId: player.id
    });

    // UNO-style turns (SINGLE / PAIR / TRIPLE): draw 1 then immediately pass the turn; do NOT start a new round.
    if (
      this.hasActiveRound &&
      (this.lastPlayedHandType === HandType.SINGLE ||
        this.lastPlayedHandType === HandType.PAIR ||
        this.lastPlayedHandType === HandType.TRIPLE)
    ) {
      this.nextTurn();
      return;
    }

    // Combo-round pass rule: if everyone else passed, the last player who played becomes the leader.
    this.passCount++;
    if (this.passCount >= this.players.length - 1 && this.lastPlayedBy) {
      const leaderId = this.lastPlayedBy;
      this.startNewRoundWithLeader(leaderId);
      this.sendGameStateToAll();
      return;
    }

    this.nextTurn();
  }

  /**
   * 处理UNO宣告
   */
  private handleDeclareUno(player: Player): void {
    if (player.hand.length !== 1) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '只有手牌剩1张时才能宣告UNO'
      });
      return;
    }

    if (player.hasCalledUno) return;

    player.hasCalledUno = true;
    this.clearUnoTimer(player.id);
    logger.info('uno_declared', { roomId: this.roomId, playerId: player.id });

    this.broadcast({
      type: 'UNO_DECLARED',
      playerId: player.id,
      playerName: player.name
    });
    this.sendGameStateToAll();
  }

  /**
   * 给玩家摸牌
   */
  private drawCardsForPlayer(player: Player, count: number): void {
    const drawnCards: Card[] = [];
    for (let i = 0; i < count; i++) {
      if (this.deck.length === 0) {
        // 牌堆空了，重新洗弃牌堆
        if (this.discardPile.length > 0) {
          const allDiscarded = this.discardPile.flat();
          this.deck = shuffleDeck(allDiscarded);
          this.discardPile = [];
        } else {
          break; // 没牌了
        }
      }
      const card = this.deck.pop();
      if (card) {
        player.hand.push(card);
        drawnCards.push(card);
      }
    }

    this.sendToPlayer(player.id, {
      type: 'CARDS_DRAWN',
      cards: drawnCards,
      count: drawnCards.length
    });

    this.broadcast({
      type: 'PLAYER_DREW_CARDS',
      playerId: player.id,
      count: drawnCards.length
    });

    this.onPlayerHandChanged(player);
  }

  /**
   * 下一回合
   */
  private nextTurn(): void {
    // Move to the next player, automatically consuming any "skip" flags.
    // If there is a pending +2/+4 chain, auto-resolve it for players who cannot respond.
    if (this.players.length === 0) return;

    for (let safety = 0; safety < this.players.length + 2; safety++) {
      let nextIndex = this.getNextPlayerIndex();
      for (let i = 0; i < this.players.length; i++) {
        const candidate = this.players[nextIndex];
        if (!candidate.isSkipped) break;
        candidate.isSkipped = false;
        nextIndex = (nextIndex + this.turnDirection + this.players.length) % this.players.length;
      }

      this.currentPlayerIndex = nextIndex;

      if (this.pendingDrawCount > 0) {
        const current = this.players[this.currentPlayerIndex];
        const canRespond = this.playerCanRespondToPendingDraw(current);
        if (!canRespond) {
          const count = this.pendingDrawCount;
          this.pendingDrawCount = 0;
          this.pendingDrawType = null;
          this.drawCardsForPlayer(current, count);
          this.broadcast({
            type: 'DRAW_PENALTY_FORCED',
            playerId: current.id,
            count
          });
          // Current player loses the turn after taking the penalty; advance again.
          continue;
        }

        const allowedCardTypes =
          this.pendingDrawType === CardType.WILD_DRAW_FOUR
            ? [CardType.WILD_DRAW_FOUR, 'BOMB']
            : [CardType.DRAW_TWO, CardType.WILD_DRAW_FOUR, 'BOMB'];

        const allowText = this.pendingDrawType === CardType.WILD_DRAW_FOUR ? '+4' : '+2/+4';
        this.sendToPlayer(current.id, {
          type: 'PENDING_DRAW',
          count: this.pendingDrawCount,
          pendingDrawType: this.pendingDrawType,
          allowedCardTypes,
          message: `You may respond with ${allowText} or a bomb, or PASS to accept the penalty`
        });
      }

      break;
    }

    this.broadcast({
      type: 'TURN_CHANGED',
      currentPlayerId: this.players[this.currentPlayerIndex].id
    });

    this.sendGameStateToAll();
  }

  /**
   * 获取下一个玩家索引
   */
  private getNextPlayerIndex(): number {
    return (this.currentPlayerIndex + this.turnDirection + this.players.length) % this.players.length;
  }

  /**
   * 结束游戏
   */
  private endGame(winnerId: string): void {
    this.gamePhase = GamePhase.ENDED;
    const winner = this.players.find(p => p.id === winnerId);
    for (const timer of this.unoTimers.values()) {
      clearTimeout(timer);
    }
    this.unoTimers.clear();
    this.unoDeadlineMsByPlayerId.clear();

    this.broadcast({
      type: 'GAME_OVER',
      winner: winnerId,
      winnerName: winner?.name || 'Unknown'
    });
  }

  /**
   * 广播消息给所有玩家
   */
  broadcast(message: any): void {
    const messageStr = JSON.stringify(message);
    for (const player of this.players) {
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(messageStr);
      }
    }
  }

  /**
   * 发送消息给特定玩家
   */
  sendToPlayer(playerId: string, message: any): void {
    const player = this.players.find(p => p.id === playerId);
    if (player && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(message));
    }
  }

  /**
   * 发送游戏状态给所有玩家
   */
  sendGameStateToAll(): void {
    for (const player of this.players) {
      this.sendToPlayer(player.id, {
        type: 'GAME_STATE',
        gameState: {
          phase: this.gamePhase,
          currentPlayerId: this.players[this.currentPlayerIndex]?.id,
          turnDirection: this.turnDirection,
          currentColor: this.currentColor,
          lastPlayedHand: this.lastPlayedHand,
          lastPlayedHandType: this.lastPlayedHandType,
          pendingDrawCount: this.pendingDrawCount,
          pendingDrawType: this.pendingDrawType,
          deckCount: this.deck.length,
          players: this.players.map(p => 
            p.id === player.id
              ? {
                  ...getPlayerPrivateInfo(p),
                  unoDeadlineMs: this.unoDeadlineMsByPlayerId.get(p.id) ?? null,
                  unoCallTimeoutMs: UNO_CALL_TIMEOUT_MS
                }
              : getPlayerPublicInfo(p)
          )
        }
      });
    }
  }
}
