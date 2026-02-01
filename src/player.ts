/**
 * Player module
 * Manages player state, hand, and public/private views.
 */

import { Card } from './card';
import WebSocket from 'ws';

export interface Player {
  id: string;
  name: string;
  hand: Card[];
  ws: WebSocket;
  hasCalledUno: boolean;
  meldedCards: Card[][];
  isSkipped: boolean;
  isConnected: boolean;
}

export function createPlayer(id: string, name: string, ws: WebSocket): Player {
  return {
    id,
    name,
    hand: [],
    ws,
    hasCalledUno: false,
    meldedCards: [],
    isSkipped: false,
    isConnected: true
  };
}

export function dealCards(player: Player, cards: Card[]): void {
  player.hand.push(...cards);
}

export function removeCardsFromHand(player: Player, cardsToRemove: Card[]): boolean {
  for (const card of cardsToRemove) {
    const index = player.hand.findIndex(c => c.id === card.id);
    if (index === -1) return false;
    player.hand.splice(index, 1);
  }
  return true;
}

export function hasCards(player: Player, cards: Card[]): boolean {
  return cards.every(card => player.hand.some(c => c.id === card.id));
}

export function getPlayerPublicInfo(player: Player) {
  return {
    id: player.id,
    name: player.name,
    handCount: player.hand.length,
    hasCalledUno: player.hasCalledUno,
    meldedCards: player.meldedCards,
    isSkipped: player.isSkipped,
    isConnected: player.isConnected
  };
}

export function getPlayerPrivateInfo(player: Player) {
  return {
    id: player.id,
    name: player.name,
    hand: player.hand,
    handCount: player.hand.length,
    hasCalledUno: player.hasCalledUno,
    meldedCards: player.meldedCards,
    isSkipped: player.isSkipped,
    isConnected: player.isConnected
  };
}
