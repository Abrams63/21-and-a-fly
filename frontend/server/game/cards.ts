import type { Card, Rank, Suit } from "../../shared/protocol";

const SUITS: Suit[] = ["spades", "hearts", "diamonds", "clubs"];
const RANKS: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

/** Blackjack value of a single card, aces counted as 1. */
export function cardValue(card: Card): number {
  if (card.rank === "A") return 1;
  if (card.rank === "J" || card.rank === "Q" || card.rank === "K") return 10;
  return Number(card.rank);
}

export interface HandValue {
  total: number;
  /** An ace is currently counted as 11. */
  soft: boolean;
}

export function handValue(cards: Card[]): HandValue {
  let total = 0;
  let hasAce = false;
  for (const card of cards) {
    total += cardValue(card);
    if (card.rank === "A") hasAce = true;
  }
  if (hasAce && total + 10 <= 21) return { total: total + 10, soft: true };
  return { total, soft: false };
}

export function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

/** A multi-deck shoe that reshuffles itself once it runs low. */
export class Shoe {
  private cards: Card[] = [];

  constructor(
    private readonly decks = 6,
    private readonly reshuffleAt = 0.25,
  ) {
    this.shuffle();
  }

  get needsShuffle(): boolean {
    return this.cards.length < this.decks * 52 * this.reshuffleAt;
  }

  shuffle(): void {
    const cards: Card[] = [];
    for (let d = 0; d < this.decks; d++) {
      for (const suit of SUITS) for (const rank of RANKS) cards.push({ rank, suit });
    }
    // Fisher–Yates
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = cards[i];
      const b = cards[j];
      if (a && b) [cards[i], cards[j]] = [b, a];
    }
    this.cards = cards;
  }

  draw(): Card {
    const card = this.cards.pop();
    if (!card) {
      this.shuffle();
      return this.draw();
    }
    return card;
  }
}
