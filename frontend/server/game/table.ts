import { type Bank, MAX_BET, MIN_BET, newFlyBalance, START_BALANCE } from "../../shared/bank";
import type {
  Card,
  ClientMessage,
  Gambler,
  HandStatus,
  HandView,
  LogEntry,
  Outcome,
  Phase,
  SeatId,
  SeatScore,
  ServerMessage,
  TableState,
} from "../../shared/protocol";
import type { Brain } from "../brain/brain";
import { cardValue, handValue, isBlackjack, Shoe } from "./cards";
import { netPayout, outcome } from "./rules";

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
  private hands: Record<SeatId, Card[]> = { player: [], fly: [], dealer: [] };
  private status: Record<SeatId, HandStatus> = { player: "waiting", fly: "waiting", dealer: "waiting" };
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
    this.hands = { player: [], fly: [], dealer: [] };
    this.status = { player: "waiting", fly: "waiting", dealer: "waiting" };
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
    this.hands = { player: [], fly: [], dealer: [] };
    this.results = {};
    this.holeHidden = true;
    this.status = { player: "waiting", fly: "waiting", dealer: "waiting" };
    this.phase = "dealing";
    this.log("system", `round ${this.roundId} · bets ${bet}`);

    // One card at a time, like a real dealer: you, the fly, the dealer, twice.
    for (let i = 0; i < 2; i++) {
      for (const seat of ["player", "fly", "dealer"] as const) {
        this.hands[seat].push(this.shoe.draw());
        this.pushState();
        if (!(await this.pause(DEAL_MS))) return;
      }
    }

    if (isBlackjack(this.hands.player)) {
      this.status.player = "blackjack";
      this.log("player", "blackjack!");
    }
    if (isBlackjack(this.hands.fly)) {
      this.status.fly = "blackjack";
      this.log("fly", "blackjack!");
    }
    if (this.status.player === "blackjack" || this.status.fly === "blackjack") {
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
        if (this.status.player === "waiting") this.status.player = "stood";
        if (this.status.fly === "waiting") this.status.fly = "stood";
        await this.settle();
        return;
      }
    }

    if (this.status.player === "blackjack") {
      await this.flyAndDealer();
      return;
    }
    this.status.player = "playing";
    this.phase = "player";
    this.pushState();
  }

  private playerHit(): void {
    if (this.busy || this.phase !== "player") return;
    const card = this.shoe.draw();
    this.hands.player.push(card);
    const { total } = handValue(this.hands.player);
    this.log("player", `hit ${cardName(card)} → ${total}`);
    if (total > 21) {
      this.status.player = "bust";
      this.log("player", "bust");
    } else if (total === 21) {
      this.status.player = "stood";
    } else {
      this.pushState();
      return;
    }
    void this.run(() => this.flyAndDealer());
  }

  private playerStand(): void {
    if (this.busy || this.phase !== "player") return;
    this.status.player = "stood";
    this.log("player", `stand on ${handValue(this.hands.player).total}`);
    void this.run(() => this.flyAndDealer());
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

    const everyoneBust = this.status.player === "bust" && this.status.fly === "bust";
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
    const bets = this.bets ?? { player: 0, fly: 0 };
    const settled = (seat: Gambler) => {
      const result = outcome(this.hands[seat], this.hands.dealer);
      const net = netPayout(result, bets[seat], isBlackjack(this.hands[seat]));
      this.results[seat] = result;
      this.payouts[seat] = net;
      this.bank[seat] += bets[seat] + net;
      this.score[seat][result]++;
      return { result, net };
    };
    const you = settled("player");
    const fly = settled("fly");
    this.phase = "settled";
    const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));
    this.log("system", `you: ${you.result} ${fmt(you.net)} · fly: ${fly.result} ${fmt(fly.net)}`);
    const score = () => `you ${this.bank.fliesBeaten} : ${this.bank.beatenByFlies} flies`;
    if (fly.net > you.net) {
      this.bank.beatenByFlies++;
      this.log("fly", `beat you this round · ${score()}`);
    } else if (you.net > fly.net) {
      this.bank.fliesBeaten++;
      this.log("player", `beat the fly this round · ${score()}`);
    }

    const reward = REWARD[fly.result];
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

  private view(seat: SeatId): HandView {
    const cards = this.hands[seat];
    const first = cards[0];
    const hidden = seat === "dealer" && this.holeHidden && first !== undefined && cards.length > 1;
    const visible = hidden ? cards.slice(0, 1) : cards;
    const value = handValue(visible);
    return {
      cards: hidden ? [first, null] : [...cards],
      total: visible.length ? value.total : null,
      soft: value.soft,
      status: this.status[seat],
    };
  }

  private snapshot(): TableState {
    return {
      roundId: this.roundId,
      phase: this.phase,
      hands: { player: this.view("player"), fly: this.view("fly"), dealer: this.view("dealer") },
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
