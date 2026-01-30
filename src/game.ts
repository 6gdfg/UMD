/**
 * 游戏核心逻辑模块 - 第1部分
 * 管理整个牌局的状态和规则
 */

import { Card, CardType, CardColor, createDeck, shuffleDeck, cardsAreIdentical, getCardPower } from './card';
import { Player, createPlayer, dealCards, removeCardsFromHand, hasCards, getPlayerPublicInfo, getPlayerPrivateInfo } from './player';
import WebSocket from 'ws';

export enum GamePhase {
  WAITING = 'waiting',
  PLAYING = 'playing',
  ENDED = 'ended'
}

export enum HandType {
  SINGLE = 'single',
  PAIR = 'pair',
  TRIPLE = 'triple',
  STRAIGHT = 'straight',
  CONSECUTIVE_PAIRS = 'consecutive_pairs',
  AIRPLANE = 'airplane',
  BOMB = 'bomb'
}

export interface PlayerAction {
  type: 'PLAY_CARDS' | 'DRAW_CARD' | 'CHI' | 'PENG' | 'GANG' | 'DECLARE_UNO' | 'PASS';
  cards?: Card[];
  playerId: string;
}

export interface PotentialAction {
  type: 'CHI' | 'PENG' | 'GANG';
  playerId: string;
  cards: Card[];
  targetCard: Card;
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
  pendingActions: PotentialAction[] = [];
  actionTimeout: NodeJS.Timeout | null = null;
  roomId: string;
  hasActiveRound: boolean = false;
  passCount: number = 0;

  constructor(roomId: string) {
    this.roomId = roomId;
    this.deck = shuffleDeck(createDeck());
  }

  addPlayer(id: string, name: string, ws: WebSocket): boolean {
    if (this.gamePhase !== GamePhase.WAITING) return false;
    if (this.players.length >= 10) return false;
    if (this.players.some(p => p.id === id)) return false;

    const player = createPlayer(id, name, ws);
    this.players.push(player);
    
    this.broadcast({
      type: 'PLAYER_JOINED',
      player: getPlayerPublicInfo(player),
      playerCount: this.players.length
    });

    return true;
  }

  removePlayer(playerId: string): void {
    const index = this.players.findIndex(p => p.id === playerId);
    if (index !== -1) {
      this.players.splice(index, 1);
      this.broadcast({
        type: 'PLAYER_LEFT',
        playerId,
        playerCount: this.players.length
      });
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
    this.hasActiveRound = false;

    this.broadcast({
      type: 'GAME_STARTED',
      currentPlayerId: this.players[this.currentPlayerIndex].id
    });

    this.sendGameStateToAll();
    return true;
  }

  handlePlayerAction(action: PlayerAction): void {
    const player = this.players.find(p => p.id === action.playerId);
    if (!player) {
      this.sendToPlayer(action.playerId, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '玩家不存在'
      });
      return;
    }

    switch (action.type) {
      case 'PLAY_CARDS':
        this.handlePlayCards(player, action.cards || []);
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

  private handlePlayCards(player: Player, cards: Card[]): void {
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

    if (!this.isValidPlay(cards, this.lastPlayedHand, handType)) {
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

    this.broadcast({
      type: 'CARDS_PLAYED',
      playerId: player.id,
      cards: cards,
      handType: handType,
      remainingCards: player.hand.length
    });

    if (player.hand.length === 0) {
      this.endGame(player.id);
      return;
    }

    if (player.hand.length === 1 && !player.hasCalledUno) {
      setTimeout(() => {
        if (!player.hasCalledUno && player.hand.length === 1) {
          this.broadcast({
            type: 'UNO_PENALTY',
            playerId: player.id,
            message: `${player.name}未宣告UNO，罚摸2张`
          });
          this.drawCardsForPlayer(player, 2);
        }
      }, 5000);
    }

    this.applyCardEffects(cards, player);

    if (handType === HandType.SINGLE) {
      this.findPotentialActions(cards[0], player);
    } else {
      this.nextTurn();
    }
  }

  /**
   * 识别牌型
   */
  private identifyHandType(cards: Card[]): HandType | null {
    if (cards.length === 0) return null;

    if (cards.length === 1) return HandType.SINGLE;

    // 检查是否所有牌完全相同
    const allSame = cards.every(c => cardsAreIdentical(c, cards[0]));
    
    if (allSame) {
      if (cards.length === 2) return HandType.PAIR;
      if (cards.length === 3) return HandType.TRIPLE;
      if (cards.length === 4) return HandType.BOMB;
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
    const pairs: number[] = [];
    const cardMap = new Map<string, Card[]>();
    
    for (const card of cards) {
      if (card.type !== CardType.NUMBER) return false;
      const key = `${card.color}-${card.value}`;
      if (!cardMap.has(key)) cardMap.set(key, []);
      cardMap.get(key)!.push(card);
    }

    for (const [key, group] of cardMap) {
      if (group.length !== 2) return false;
      pairs.push(parseInt(group[0].value));
    }

    pairs.sort((a, b) => a - b);
    for (let i = 1; i < pairs.length; i++) {
      if (pairs[i] !== pairs[i - 1] + 1) return false;
    }
    return true;
  }

  private isAirplane(cards: Card[]): boolean {
    const triples: number[] = [];
    const cardMap = new Map<string, Card[]>();
    
    for (const card of cards) {
      if (card.type !== CardType.NUMBER) return false;
      const key = `${card.color}-${card.value}`;
      if (!cardMap.has(key)) cardMap.set(key, []);
      cardMap.get(key)!.push(card);
    }

    for (const [key, group] of cardMap) {
      if (group.length !== 3) return false;
      triples.push(parseInt(group[0].value));
    }

    triples.sort((a, b) => a - b);
    for (let i = 1; i < triples.length; i++) {
      if (triples[i] !== triples[i - 1] + 1) return false;
    }
    return true;
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
      return true;
    }

    // 牌型必须一致
    if (this.lastPlayedHandType !== handType) {
      return false;
    }

    // 根据牌型比较大小
    switch (handType) {
      case HandType.SINGLE:
        return this.compareSingleCards(playedCards[0], lastCards[0]);
      case HandType.PAIR:
      case HandType.TRIPLE:
        return this.compareGroups(playedCards, lastCards);
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
  private compareGroups(played: Card[], last: Card[]): boolean {
    return this.compareSingleCards(played[0], last[0]);
  }

  /**
   * 比较顺子/连对/飞机
   */
  private compareSequences(played: Card[], last: Card[]): boolean {
    if (played.length !== last.length) return false;
    
    const playedMax = Math.max(...played.map(c => parseInt(c.value)));
    const lastMax = Math.max(...last.map(c => parseInt(c.value)));
    
    return playedMax > lastMax;
  }

  /**
   * 比较炸弹
   */
  private compareBombs(played: Card[], last: Card[]): boolean {
    const playedValue = parseInt(played[0].value);
    const lastValue = parseInt(last[0].value);
    return playedValue > lastValue;
  }

  /**
   * 应用卡牌效果
   */
  private applyCardEffects(cards: Card[], player: Player): void {
    for (const card of cards) {
      switch (card.type) {
        case CardType.SKIP:
          // 跳过下一个玩家
          const nextIndex = this.getNextPlayerIndex();
          this.players[nextIndex].isSkipped = true;
          this.broadcast({
            type: 'PLAYER_SKIPPED',
            playerId: this.players[nextIndex].id
          });
          break;

        case CardType.REVERSE:
          // 反转方向
          this.turnDirection *= -1;
          this.broadcast({
            type: 'DIRECTION_REVERSED',
            newDirection: this.turnDirection
          });
          break;

        case CardType.DRAW_TWO:
          // 下一个玩家摸2张
          const nextPlayer = this.players[this.getNextPlayerIndex()];
          this.drawCardsForPlayer(nextPlayer, 2);
          // +2: penalized player draws and loses their turn
          nextPlayer.isSkipped = true;
          this.broadcast({
            type: 'PLAYER_SKIPPED',
            playerId: nextPlayer.id
          });
          break;

        case CardType.WILD_DRAW_FOUR:
          // 所有其他玩家摸4张
          const nextPlayerForDraw4 = this.players[this.getNextPlayerIndex()];
          this.drawCardsForPlayer(nextPlayerForDraw4, 4);
          // +4: penalized player draws and loses their turn
          nextPlayerForDraw4.isSkipped = true;
          this.broadcast({
            type: 'PLAYER_SKIPPED',
            playerId: nextPlayerForDraw4.id
          });
          break;
      }
    }
  }

  /**
   * 查找潜在的吃碰杠动作
   */
  private findPotentialActions(card: Card, playedBy: Player): void {
    this.pendingActions = [];

    for (let i = 0; i < this.players.length; i++) {
      const player = this.players[i];
      if (player.id === playedBy.id) continue;

      // 检查杠（3张相同）
      const gangCards = player.hand.filter(c => cardsAreIdentical(c, card));
      if (gangCards.length >= 3) {
        this.pendingActions.push({
          type: 'GANG',
          playerId: player.id,
          cards: gangCards.slice(0, 3),
          targetCard: card
        });
      }

      // 检查碰（2张相同）
      const pengCards = player.hand.filter(c => cardsAreIdentical(c, card));
      if (pengCards.length >= 2) {
        this.pendingActions.push({
          type: 'PENG',
          playerId: player.id,
          cards: pengCards.slice(0, 2),
          targetCard: card
        });
      }

      // 检查吃（只能吃上家的数字牌，且必须同色）
      const prevPlayerIndex = (this.currentPlayerIndex - 1 + this.players.length) % this.players.length;
      if (i === this.getNextPlayerIndex() && 
          playedBy.id === this.players[prevPlayerIndex].id &&
          card.type === CardType.NUMBER) {
        
        const cardValue = parseInt(card.value);
        const sameColorCards = player.hand.filter(c => 
          c.color === card.color && c.type === CardType.NUMBER
        );

        // 检查能否组成顺子
        const values = sameColorCards.map(c => parseInt(c.value));
        
        // 吃法1: card-1, card-2
        if (values.includes(cardValue - 1) && values.includes(cardValue - 2)) {
          const chiCards = [
            sameColorCards.find(c => parseInt(c.value) === cardValue - 2)!,
            sameColorCards.find(c => parseInt(c.value) === cardValue - 1)!
          ];
          this.pendingActions.push({
            type: 'CHI',
            playerId: player.id,
            cards: chiCards,
            targetCard: card
          });
        }

        // 吃法2: card+1, card-1
        if (values.includes(cardValue - 1) && values.includes(cardValue + 1)) {
          const chiCards = [
            sameColorCards.find(c => parseInt(c.value) === cardValue - 1)!,
            sameColorCards.find(c => parseInt(c.value) === cardValue + 1)!
          ];
          this.pendingActions.push({
            type: 'CHI',
            playerId: player.id,
            cards: chiCards,
            targetCard: card
          });
        }

        // 吃法3: card+1, card+2
        if (values.includes(cardValue + 1) && values.includes(cardValue + 2)) {
          const chiCards = [
            sameColorCards.find(c => parseInt(c.value) === cardValue + 1)!,
            sameColorCards.find(c => parseInt(c.value) === cardValue + 2)!
          ];
          this.pendingActions.push({
            type: 'CHI',
            playerId: player.id,
            cards: chiCards,
            targetCard: card
          });
        }
      }
    }

    if (this.pendingActions.length > 0) {
      // 通知相关玩家
      for (const action of this.pendingActions) {
        this.sendToPlayer(action.playerId, {
          type: 'POTENTIAL_ACTION',
          actions: [action.type],
          targetCard: action.targetCard
        });
      }

      // 设置5秒超时
      this.actionTimeout = setTimeout(() => {
        this.pendingActions = [];
        this.nextTurn();
      }, 5000);
    } else {
      this.nextTurn();
    }
  }

  /**
   * 处理吃牌
   */
  private handleChi(player: Player, cards: Card[]): void {
    const action = this.pendingActions.find(a => 
      a.playerId === player.id && a.type === 'CHI'
    );

    if (!action) {
      this.sendToPlayer(player.id, {
        type: 'ACTION_VALIDATION',
        isValid: false,
        message: '无法吃牌'
      });
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

    // 清除超时
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }

    // 执行吃牌
    removeCardsFromHand(player, cards);
    const meldedSet = [...cards, action.targetCard];
    player.meldedCards.push(meldedSet);

    this.broadcast({
      type: 'CHI_PERFORMED',
      playerId: player.id,
      cards: meldedSet
    });

    // 清空待处理动作
    this.pendingActions = [];

    // 该玩家获得出牌权
    this.currentPlayerIndex = this.players.findIndex(p => p.id === player.id);
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

    removeCardsFromHand(player, action.cards);
    const meldedSet = [...action.cards, action.targetCard];
    player.meldedCards.push(meldedSet);

    this.broadcast({
      type: 'PENG_PERFORMED',
      playerId: player.id,
      cards: meldedSet
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
    this.currentPlayerIndex = this.players.findIndex(p => p.id === player.id);
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

    removeCardsFromHand(player, action.cards);
    const meldedSet = [...action.cards, action.targetCard];
    player.meldedCards.push(meldedSet);

    this.broadcast({
      type: 'GANG_PERFORMED',
      playerId: player.id,
      cards: meldedSet
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
    this.currentPlayerIndex = this.players.findIndex(p => p.id === player.id);
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

    // Pass时摸一张牌
    this.drawCardsForPlayer(player, 1);

    this.passCount++;
    
    this.broadcast({
      type: 'PLAYER_PASSED',
      playerId: player.id
    });

    // 如果所有其他玩家都pass了，上一个出牌的玩家获得主动权
    if (this.passCount >= this.players.length - 1 && this.lastPlayedBy) {
      this.currentPlayerIndex = this.players.findIndex(p => p.id === this.lastPlayedBy);
      this.lastPlayedHand = [];
      this.lastPlayedHandType = null;
      this.hasActiveRound = false;
      this.passCount = 0;

      this.broadcast({
        type: 'NEW_ROUND',
        leadPlayerId: this.lastPlayedBy,
        message: '所有人都pass，新一轮开始'
      });

      this.sendGameStateToAll();
    } else {
      this.nextTurn();
    }
  }

  /**
   * 处理UNO宣告
   */
  private handleDeclareUno(player: Player): void {
    if (player.hand.length === 1) {
      player.hasCalledUno = true;
      this.broadcast({
        type: 'UNO_DECLARED',
        playerId: player.id,
        playerName: player.name
      });
    }
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
  }

  /**
   * 下一回合
   */
  private nextTurn(): void {
    // Move to the next player, automatically consuming any "skip" flags.
    if (this.players.length === 0) return;

    let nextIndex = this.getNextPlayerIndex();
    for (let i = 0; i < this.players.length; i++) {
      const candidate = this.players[nextIndex];
      if (!candidate.isSkipped) break;
      candidate.isSkipped = false;
      nextIndex = (nextIndex + this.turnDirection + this.players.length) % this.players.length;
    }

    this.currentPlayerIndex = nextIndex;
    
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
          lastPlayedHand: this.lastPlayedHand,
          lastPlayedHandType: this.lastPlayedHandType,
          deckCount: this.deck.length,
          players: this.players.map(p => 
            p.id === player.id ? getPlayerPrivateInfo(p) : getPlayerPublicInfo(p)
          )
        }
      });
    }
  }
}
