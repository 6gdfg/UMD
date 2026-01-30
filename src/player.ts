/**
 * 玩家模块
 * 管理玩家手牌和状态
 */

import { Card } from './card';
import WebSocket from 'ws';

export interface Player {
  id: string;                    // 玩家唯一ID
  name: string;                  // 玩家名称
  hand: Card[];                  // 手牌
  ws: WebSocket;                 // WebSocket连接
  hasCalledUno: boolean;         // 是否已宣告UNO
  meldedCards: Card[][];         // 已经吃/碰/杠的牌组
  isSkipped: boolean;            // 本回合是否被跳过
}

/**
 * 创建新玩家
 */
export function createPlayer(id: string, name: string, ws: WebSocket): Player {
  return {
    id,
    name,
    hand: [],
    ws,
    hasCalledUno: false,
    meldedCards: [],
    isSkipped: false
  };
}

/**
 * 给玩家发牌
 */
export function dealCards(player: Player, cards: Card[]): void {
  player.hand.push(...cards);
}

/**
 * 从玩家手牌中移除指定的牌
 */
export function removeCardsFromHand(player: Player, cardsToRemove: Card[]): boolean {
  for (const card of cardsToRemove) {
    const index = player.hand.findIndex(c => c.id === card.id);
    if (index === -1) {
      return false; // 玩家没有这张牌
    }
    player.hand.splice(index, 1);
  }
  return true;
}

/**
 * 检查玩家是否有指定的牌
 */
export function hasCards(player: Player, cards: Card[]): boolean {
  for (const card of cards) {
    if (!player.hand.some(c => c.id === card.id)) {
      return false;
    }
  }
  return true;
}

/**
 * 获取玩家的公开信息（不包含手牌详情）
 */
export function getPlayerPublicInfo(player: Player) {
  return {
    id: player.id,
    name: player.name,
    handCount: player.hand.length,
    hasCalledUno: player.hasCalledUno,
    meldedCards: player.meldedCards,
    isSkipped: player.isSkipped
  };
}

/**
 * 获取玩家的完整信息（包含手牌）
 */
export function getPlayerPrivateInfo(player: Player) {
  return {
    id: player.id,
    name: player.name,
    hand: player.hand,
    handCount: player.hand.length,
    hasCalledUno: player.hasCalledUno,
    meldedCards: player.meldedCards,
    isSkipped: player.isSkipped
  };
}
