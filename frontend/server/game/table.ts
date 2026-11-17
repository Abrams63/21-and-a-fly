import { type Bank, MAX_BET, MIN_BET, newFlyBalance, START_BALANCE } from "../../shared/bank";
import type {
  Card,
  ClientMessage,
  HandStatus,
  HandView,
  LogEntry,
  Outcome,
  Phase,
  PlayerHandView,
  SeatScore,
  ServerMessage,
  TableState,
} from "../../shared/protocol";
import type { Brain } from "../brain/brain";
import { cardValue, handValue, isBlackjack, Shoe } from "./cards";
import { canSplitCards, netPayout, outcome } from "./rules";

/** How long the client replays one fly decision (100 ms of simulated time, slowed down). */
const FLY_REPLAY_MS = 1600;
const DOPAMINE_REPLAY_MS = 1200;
const EVICTION_MS = 2800;
const STEP_MS = 650;
/** Pause between dealt cards, so you can follow who got what. */
const DEAL_MS = 420;

const SUIT_SYMBOL: Record<Card["suit"], string> = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
};
const cardName = (c: Card) => `${c.rank}${SUIT_SYMBOL[c.suit]}`;

function cardAt(cards: Card[], index: number): Card {
  const card = cards[index];
  if (!card) throw new Error(`no card at position ${index}`);
  return card;
}

const emptyScore = (): SeatScore => ({ win: 0, lose: 0, push: 0 });

const REWARD: Record<Outcome, number> = { win: 1, lose: -1, push: 0 };

/** One of your hands. A split turns one into two, each with its own bet. */
interface PlayerHand {
  cards: Card[];
  status: HandStatus;
  bet: number;
  doubled: boolean;
  /** Came from a split: a two-card 21 is not a blackjack, and split aces get one card each. */
  split: boolean;
  result?: Outcome;
  payout?: number;
}

const newHand = (bet: number, cards: Card[] = [], split = false): PlayerHand => ({
  cards,
  status: "waiting",
  bet,
  doubled: false,
  split,
});

type Other = "fly" | "dealer";

export interface TableOptions {
  /** Where the cards come from; tests pass a stacked shoe. */
  shoe?: Shoe;
  /** Multiplies every pause of the table scene; 0 plays a round instantly. */
  pace?: number;
}

/** One game table: you, the fly and a rule-following dealer. One per browser connection. */
export class Table {
  private readonly shoe: Shoe;
  private readonly pace: number;
  private roundId = 0;
  private phase: Phase = "idle";
  private player: PlayerHand[] = [newHand(0)];
  /** Index of the hand you are playing. */
  private active = 0;
  private hands: Record<Other, Card[]> = { fly: [], dealer: [] };
  private status: Record<Other, HandStatus> = { fly: "waiting", dealer: "waiting" };
  private holeHidden = true;
  private results: TableState["results"] = {};
  private bets: TableState["bets"] = null;
  private payouts: TableState["payouts"] = {};
  private score = { player: emptyScore(), fly: emptyScore() };
  private busy = false;
  private closed = false;
  private logId = 0;
  /** How drunk this table's fly is, 0..1. Other tables have their own flies. */
  private drunk = 0;

  constructor(
    private readonly id: string,
    private readonly brain: Brain,
    private readonly bank: Bank,
    private readonly send: (message: ServerMessage) => void,
    options: TableOptions = {},
  ) {
    this.shoe = options.shoe ?? new Shoe();
    this.pace = options.pace ?? 1;
  }

  private unsubscribe: (() => void) | null = null;

  hello(): void {
    this.send({ type: "hello", topology: this.brain.topology, state: this.snapshot() });
    this.log("system", "table open · dealer draws to 17");
    // The brain can switch between the PyTorch service and the mock at any time.
    this.unsubscribe = this.brain.subscribe(() => {
      if (this.closed) return;
      this.send({ type: "hello", topology: this.brain.topology, state: this.snapshot() });
      const info = this.brain.info(this.flyKey);
      this.log(
        "system",
        info.source === "python"
          ? `PyTorch brain online · ${info.wiring} wiring`
          : "PyTorch brain offline · TS mock takes over",
      );
    });
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
  }

  handle(message: ClientMessage): void {
    switch (message.type) {
      case "new_round":
        this.newRound(message.bet);
        break;
      case "rebuy":
        this.rebuy();
        break;
      case "hit":
        this.playerHit();
        break;
      case "stand":
        this.playerStand();
        break;
      case "double":
        this.playerDouble();
        break;
      case "split":
        this.playerSplit();
        break;
      case "set_drunk":
        this.drunk = Math.min(1, Math.max(0, message.value));
        this.pushState();
        break;
      case "reset_brain":
        void this.resetBrain(message.mode);
        break;
    }
  }

  // ---- round flow ----------------------------------------------------------

  private get betweenRounds(): boolean {
    return !this.busy && (this.phase === "idle" || this.phase === "settled");
  }

  private newRound(bet: number): void {
    if (!this.betweenRounds) return;
    if (!Number.isSafeInteger(bet) || bet < MIN_BET || bet > MAX_BET) {
      this.fail(`Bets go from ${MIN_BET} to ${MAX_BET.toLocaleString("en-US")}`);
      return;
    }
    if (bet > this.bank.player) {
      this.fail(`You only have ${this.bank.player} chips`);
      return;
    }

    void this.run(async () => {
      if (this.bank.fly < bet) await this.evictFly();
      if (this.closed) return;
      await this.deal(bet);
    });
  }

  /** The fly can't cover the bet: it is shooed away and a new one sits down. */
  private async evictFly(): Promise<void> {
    const ruinedNumber = this.bank.flyNumber;
    const mode = this.brain.info(this.flyKey).mode;
    this.bank.fliesRuined++;
    this.bank.flyNumber++;
    this.bank.fly = newFlyBalance(this.bank.player);
    this.score.fly = emptyScore();
    this.clearHands(0);
    this.results = {};
    this.payouts = {};
    this.bets = null;
    this.phase = "idle";
    await this.brain.reset(this.flyKey, mode); // the new fly starts out like the old one did

    this.send({
      type: "fly_evicted",
      event: {
        ruinedNumber,
        newNumber: this.bank.flyNumber,
        newBalance: this.bank.fly,
        replayMs: EVICTION_MS,
      },
    });
    this.log("system", `fly #${ruinedNumber} is broke and got shooed off the table`);
    this.log("system", `fly #${this.bank.flyNumber} sits down with ${this.bank.fly} chips`);
    this.pushState();
    await this.pause(EVICTION_MS);
  }

  private clearHands(bet: number): void {
    this.player = [newHand(bet)];
    this.active = 0;
    this.hands = { fly: [], dealer: [] };
    this.status = { fly: "waiting", dealer: "waiting" };
  }

  private async deal(bet: number): Promise<void> {
    if (this.shoe.needsShuffle) {
      this.shoe.shuffle();
      this.log("dealer", "shuffling the shoe");
    }

    this.roundId++;
    this.bank.player -= bet;
    this.bank.fly -= bet;
    this.bets = { player: bet, fly: bet };
    this.payouts = {};
    this.clearHands(bet);
    this.results = {};
    this.holeHidden = true;
    this.phase = "dealing";
    this.log("system", `round ${this.roundId} · bets ${bet}`);

    // One card at a time, like a real dealer: you, the fly, the dealer, twice.
    const you = this.hand;
    for (let i = 0; i < 2; i++) {
      for (const pile of [you.cards, this.hands.fly, this.hands.dealer]) {
        pile.push(this.shoe.draw());
        this.pushState();
        if (!(await this.pause(DEAL_MS))) return;
      }
    }

    if (isBlackjack(you.cards)) {
      you.status = "blackjack";
      this.log("player", "blackjack!");
    }
    if (isBlackjack(this.hands.fly)) {
      this.status.fly = "blackjack";
      this.log("fly", "blackjack!");
    }
    if (you.status === "blackjack" || this.status.fly === "blackjack") {
      this.pushState();
      if (!(await this.pause(STEP_MS))) return;
    }

    // An ace or a ten showing: the dealer checks the hole card for a natural.
    const up = cardValue(this.upCard);
    if (up >= 10 || up === 1) {
      this.log("dealer", "checks for blackjack…");
      this.pushState();
      if (!(await this.pause(STEP_MS * 1.5))) return;
      if (isBlackjack(this.hands.dealer)) {
        this.holeHidden = false;
        this.status.dealer = "blackjack";
        this.log("dealer", `reveal ${cardName(this.holeCard)} → blackjack`);
        this.pushState();
        if (!(await this.pause(STEP_MS * 1.5))) return;
        if (you.status === "waiting") you.status = "stood";
        if (this.status.fly === "waiting") this.status.fly = "stood";
        await this.settle();
        return;
      }
    }

    if (you.status === "blackjack") {
      await this.flyAndDealer();
      return;
    }
    you.status = "playing";
    this.phase = "player";
    this.pushState();
  }

  /** The hand you are playing now. */
  private get hand(): PlayerHand {
    const hand = this.player[this.active];
    if (!hand) throw new Error(`no hand ${this.active}`);
    return hand;
  }

  private get yourTurn(): boolean {
    return !this.busy && this.phase === "player" && this.hand.status === "playing";
  }

  /** Which hand a log line is about, once there are two. */
  private get handLabel(): string {
    return this.player.length > 1 ? `hand ${this.active + 1}: ` : "";
  }

  private get canDouble(): boolean {
    const hand = this.hand;
    return this.yourTurn && hand.cards.length === 2 && this.bank.player >= hand.bet;
  }

  private get canSplit(): boolean {
    const hand = this.hand;
    return this.yourTurn && this.player.length === 1 && canSplitCards(hand.cards) && this.bank.player >= hand.bet;
  }

  private playerHit(): void {
    if (!this.yourTurn) return;
    const hand = this.hand;
    const card = this.shoe.draw();
    hand.cards.push(card);
    const { total } = handValue(hand.cards);
    this.log("player", `${this.handLabel}hit ${cardName(card)} → ${total}`);
    if (total > 21) {
      hand.status = "bust";
      this.log("player", `${this.handLabel}bust`);
    } else if (total === 21) {
      hand.status = "stood";
    } else {
      this.pushState();
      return;
    }
    this.nextHand();
  }

  private playerStand(): void {
    if (!this.yourTurn) return;
    const hand = this.hand;
    hand.status = "stood";
    this.log("player", `${this.handLabel}stand on ${handValue(hand.cards).total}`);
    this.nextHand();
  }

  /** Double the bet, take exactly one more card and stand. */
  private playerDouble(): void {
    if (!this.canDouble) return;
    const hand = this.hand;
    this.bank.player -= hand.bet;
    this.addStake(hand.bet);
    hand.bet *= 2;
    hand.doubled = true;
    const card = this.shoe.draw();
    hand.cards.push(card);
    const { total } = handValue(hand.cards);
    this.log("player", `${this.handLabel}double down to ${hand.bet}: ${cardName(card)} → ${total}`);
    if (total > 21) {
      hand.status = "bust";
      this.log("player", `${this.handLabel}bust`);
    } else {
      hand.status = "stood";
    }
    this.nextHand();
  }

  /** Split a pair into two hands, each with your bet and a second card. Split aces get one card each. */
  private playerSplit(): void {
    if (!this.canSplit) return;
    const [first, second] = this.hand.cards as [Card, Card];
    const bet = this.hand.bet;
    this.bank.player -= bet;
    this.addStake(bet);
    const aces = first.rank === "A";
    this.player = [newHand(bet, [first], true), newHand(bet, [second], true)];
    this.active = 0;
    this.log("player", `split ${cardName(first)} ${cardName(second)} · bets ${bet} + ${bet}`);
    void this.run(async () => {
      for (const hand of this.player) {
        hand.cards.push(this.shoe.draw());
        this.pushState();
        if (!(await this.pause(DEAL_MS))) return;
      }
      if (aces) {
        // Split aces get one card each and play no further.
        for (const hand of this.player) hand.status = "stood";
        this.log("player", "split aces: one card each");
        await this.flyAndDealer();
        return;
      }
      await this.startHand(0);
    });
  }

  private addStake(amount: number): void {
    if (this.bets) this.bets = { ...this.bets, player: this.bets.player + amount };
  }

  /** Plays the hand at `index`, or skips it if it is already done (21). */
  private async startHand(index: number): Promise<void> {
    this.active = index;
    const hand = this.hand;
    if (handValue(hand.cards).total === 21) {
      hand.status = "stood";
      this.log("player", `${this.handLabel}21`);
      await this.afterHand();
      return;
    }
    hand.status = "playing";
    this.phase = "player";
    this.pushState();
  }

  /** The current hand is done: move to your next hand, or let the fly play. */
  private nextHand(): void {
    void this.run(() => this.afterHand());
  }

  private async afterHand(): Promise<void> {
    if (this.active + 1 < this.player.length) {
      this.pushState();
      if (!(await this.pause(STEP_MS / 2))) return;
      await this.startHand(this.active + 1);
      return;
    }
    await this.flyAndDealer();
  }

  private async flyAndDealer(): Promise<void> {
    this.phase = "fly";
    if (this.status.fly !== "blackjack") this.status.fly = "playing";
    this.pushState();
    if (!(await this.pause(STEP_MS))) return;

    const episode = this.episode;
    while (this.status.fly === "playing") {
      const { total, soft } = handValue(this.hands.fly);
      const observation = {
        playerSum: total,
        dealerCard: cardValue(this.upCard),
        usableAce: soft,
      };
      const decision = await this.brain.decide(this.flyKey, episode, observation, this.drunk);
      if (this.closed) return;
      this.send({
        type: "think",
        event: { roundId: this.roundId, observation, replayMs: FLY_REPLAY_MS, ...decision },
      });
      if (!(await this.pause(FLY_REPLAY_MS))) return;

      const votes = `hit ${decision.mbon.hit} · stand ${decision.mbon.stand}`;
      if (decision.action === "stand") {
        this.status.fly = "stood";
        this.log("fly", `stand on ${total} (${votes})`);
      } else {
        const card = this.shoe.draw();
        this.hands.fly.push(card);
        const next = handValue(this.hands.fly).total;
        this.log("fly", `hit ${cardName(card)} → ${next} (${votes})`);
        if (next > 21) {
          this.status.fly = "bust";
          this.log("fly", "bust");
        }
      }
      this.pushState();
      if (!(await this.pause(STEP_MS / 2))) return;
    }

    await this.dealerTurn();
  }

  private async dealerTurn(): Promise<void> {
    this.phase = "dealer";
    this.holeHidden = false;
    this.status.dealer = "playing";
    const dealer = this.hands.dealer;
    this.log("dealer", `reveal ${cardName(this.holeCard)} → ${handValue(dealer).total}`);
    this.pushState();
    if (!(await this.pause(STEP_MS))) return;

    const everyoneBust = this.player.every((h) => h.status === "bust") && this.status.fly === "bust";
    if (everyoneBust) {
      this.log("dealer", "everyone busted, no need to draw");
    } else {
      while (handValue(dealer).total < 17) {
        const total = handValue(dealer).total;
        const card = this.shoe.draw();
        dealer.push(card);
        this.log("dealer", `hit on ${total}: ${cardName(card)} → ${handValue(dealer).total}`);
        this.pushState();
        if (!(await this.pause(STEP_MS))) return;
      }
    }
    const total = handValue(dealer).total;
    this.status.dealer = total > 21 ? "bust" : "stood";
    this.log("dealer", total > 21 ? `bust (${total})` : `stand on ${total}`);
    await this.settle();
  }

  private async settle(): Promise<void> {
    this.holeHidden = false;
    const dealer = this.hands.dealer;

    let yourNet = 0;
    for (const hand of this.player) {
      const natural = !hand.split && isBlackjack(hand.cards);
      const result = outcome(hand.cards, dealer, natural);
      const net = netPayout(result, hand.bet, natural);
      hand.result = result;
      hand.payout = net;
      this.bank.player += hand.bet + net;
      this.score.player[result]++;
      yourNet += net;
    }
    const yourResult: Outcome = yourNet > 0 ? "win" : yourNet < 0 ? "lose" : "push";

    const flyBet = this.bets?.fly ?? 0;
    const flyResult = outcome(this.hands.fly, dealer);
    const flyNet = netPayout(flyResult, flyBet, isBlackjack(this.hands.fly));
    this.bank.fly += flyBet + flyNet;
    this.score.fly[flyResult]++;

    this.results = { player: yourResult, fly: flyResult };
    this.payouts = { player: yourNet, fly: flyNet };
    this.phase = "settled";
    const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));
    this.log("system", `you: ${yourResult} ${fmt(yourNet)} · fly: ${flyResult} ${fmt(flyNet)}`);
    const score = () => `you ${this.bank.fliesBeaten} : ${this.bank.beatenByFlies} flies`;
    if (flyNet > yourNet) {
      this.bank.beatenByFlies++;
      this.log("fly", `beat you this round · ${score()}`);
    } else if (yourNet > flyNet) {
      this.bank.fliesBeaten++;
      this.log("player", `beat the fly this round · ${score()}`);
    }

    const reward = REWARD[flyResult];
    const { kind, frames } = await this.brain.reward(this.flyKey, this.episode, reward);
    if (this.closed) return;
    this.send({
      type: "dopamine",
      event: { roundId: this.roundId, reward, replayMs: DOPAMINE_REPLAY_MS, kind, frames },
    });
    this.pushState();
  }

  /** You can't cover the minimum bet: start over with a fresh stack. */
  private rebuy(): void {
    if (!this.betweenRounds || this.bank.player >= MIN_BET) return;
    this.bank.player = START_BALANCE;
    this.log("system", `you buy back in for ${START_BALANCE} chips`);
    this.pushState();
  }

  private async resetBrain(mode: "pretrained" | "naive"): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.brain.reset(this.flyKey, mode);
      this.log("system", mode === "naive" ? "the fly's brain was wiped" : "the fly's brain was retrained");
    } finally {
      this.busy = false;
    }
    this.pushState();
  }

  // ---- helpers -------------------------------------------------------------

  /** The fly at this table: one per browser and seat number, so a new fly is a new key. */
  private get flyKey(): string {
    return `${this.bank.id}:${this.bank.flyNumber}`;
  }

  /** The current hand, as the brain knows it. */
  private get episode(): string {
    return `${this.bank.id}:${this.id}:${this.roundId}`;
  }

  /** Runs an async step of the round, blocking player input until it ends. */
  private async run(step: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await step();
    } catch (error) {
      console.error(error);
      this.fail("Round aborted: server error");
      this.phase = "settled";
    } finally {
      this.busy = false;
    }
    if (!this.closed) this.pushState();
  }

  /** Waits, then reports whether the table is still open. */
  private async pause(ms: number): Promise<boolean> {
    await Bun.sleep(ms * this.pace);
    return !this.closed;
  }

  private fail(message: string): void {
    if (!this.closed) this.send({ type: "error", message });
  }

  /** The dealer's face-up card; exists from the third dealt card on. */
  private get upCard(): Card {
    return cardAt(this.hands.dealer, 0);
  }

  /** The dealer's face-down card; exists once the deal is complete. */
  private get holeCard(): Card {
    return cardAt(this.hands.dealer, 1);
  }

  private view(cards: Card[], status: HandStatus, hideHole = false): HandView {
    const first = cards[0];
    const hidden = hideHole && first !== undefined && cards.length > 1;
    const visible = hidden ? cards.slice(0, 1) : cards;
    const value = handValue(visible);
    return {
      cards: hidden ? [first, null] : [...cards],
      total: visible.length ? value.total : null,
      soft: value.soft,
      status,
    };
  }

  private playerView(hand: PlayerHand): PlayerHandView {
    return {
      ...this.view(hand.cards, hand.status),
      bet: hand.bet,
      doubled: hand.doubled,
      ...(hand.result && { result: hand.result, payout: hand.payout }),
    };
  }

  private snapshot(): TableState {
    return {
      roundId: this.roundId,
      phase: this.phase,
      hands: {
        fly: this.view(this.hands.fly, this.status.fly),
        dealer: this.view(this.hands.dealer, this.status.dealer, this.holeHidden),
      },
      player: {
        hands: this.player.map((hand) => this.playerView(hand)),
        active: this.active,
        canDouble: this.canDouble,
        canSplit: this.canSplit,
      },
      results: { ...this.results },
      score: { player: { ...this.score.player }, fly: { ...this.score.fly } },
      bank: { ...this.bank },
      bets: this.bets && { ...this.bets },
      payouts: { ...this.payouts },
      minBet: MIN_BET,
      drunk: this.drunk,
      brain: this.brain.info(this.flyKey),
    };
  }

  private pushState(): void {
    if (!this.closed) this.send({ type: "state", state: this.snapshot() });
  }

  private log(who: LogEntry["who"], text: string): void {
    if (!this.closed) this.send({ type: "log", entry: { id: ++this.logId, who, text } });
  }
}
