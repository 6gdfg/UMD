/**
 * 卡牌模块
 * 定义卡牌接口和牌库生成逻辑
 */

// 卡牌颜色枚举
export enum CardColor {
  RED = '红',
  YELLOW = '黄',
  BLUE = '蓝',
  GREEN = '绿',
  WILD = '万能' // 万能牌没有颜色
}

// 卡牌类型枚举
export enum CardType {
  NUMBER = 'number',      // 数字牌
  SKIP = 'skip',          // 跳过
  REVERSE = 'reverse',    // 反转
  DRAW_TWO = 'draw2',     // +2
  WILD = 'wild',          // 变色牌
  WILD_DRAW_FOUR = 'wild_draw4' // +4王牌
}

// 卡牌接口
export interface Card {
  color: CardColor;       // 颜色
  value: string;          // 值（数字0-9或功能牌名称）
  type: CardType;         // 类型
  id: string;             // 唯一标识符，用于精确匹配
}

/**
 * 创建完整的368张牌库
 * 严格按照规则生成牌库
 */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  let cardId = 0;

  // 四种颜色
  const colors = [CardColor.RED, CardColor.YELLOW, CardColor.BLUE, CardColor.GREEN];

  // 1. 生成数字牌 (304张)
  for (const color of colors) {
    // 数字0：每色4张
    for (let i = 0; i < 4; i++) {
      deck.push({
        color,
        value: '0',
        type: CardType.NUMBER,
        id: `${color}-0-${cardId++}`
      });
    }

    // 数字1-9：每色每个数字8张
    for (let num = 1; num <= 9; num++) {
      for (let i = 0; i < 8; i++) {
        deck.push({
          color,
          value: num.toString(),
          type: CardType.NUMBER,
          id: `${color}-${num}-${cardId++}`
        });
      }
    }
  }

  // 2. 生成功能牌 (48张)
  const specialCards = [
    { type: CardType.SKIP, value: '跳过' },
    { type: CardType.REVERSE, value: '反转' },
    { type: CardType.DRAW_TWO, value: '+2' }
  ];

  for (const color of colors) {
    for (const special of specialCards) {
      // 每种功能牌每色4张，总共16张
      for (let i = 0; i < 4; i++) {
        deck.push({
          color,
          value: special.value,
          type: special.type,
          id: `${color}-${special.value}-${cardId++}`
        });
      }
    }
  }

  // 3. 生成万能牌 (16张)
  // 变色牌 8张
  for (let i = 0; i < 8; i++) {
    deck.push({
      color: CardColor.WILD,
      value: '变色',
      type: CardType.WILD,
      id: `wild-${cardId++}`
    });
  }

  // +4王牌 8张
  for (let i = 0; i < 8; i++) {
    deck.push({
      color: CardColor.WILD,
      value: '+4',
      type: CardType.WILD_DRAW_FOUR,
      id: `wild-draw4-${cardId++}`
    });
  }

  return deck;
}

/**
 * 洗牌函数 - Fisher-Yates洗牌算法
 * @param deck 要洗的牌组
 * @returns 洗好的牌组
 */
export function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * 判断两张牌是否完全相同（用于碰、杠判断）
 */
export function cardsAreIdentical(card1: Card, card2: Card): boolean {
  return card1.color === card2.color && 
         card1.value === card2.value && 
         card1.type === card2.type;
}

/**
 * 获取卡牌的权力等级（用于比较大小）
 */
export function getCardPower(card: Card): number {
  // 炸弹 > +4 > +2 > 反转 > 跳过 > 数字牌
  switch (card.type) {
    case CardType.NUMBER:
      return parseInt(card.value);
    case CardType.SKIP:
      return 100;
    case CardType.REVERSE:
      return 200;
    case CardType.DRAW_TWO:
      return 300;
    case CardType.WILD:
    case CardType.WILD_DRAW_FOUR:
      return 400;
    default:
      return 0;
  }
}
