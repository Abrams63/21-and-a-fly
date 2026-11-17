import { MAX_BET } from "../shared/bank";
import type { ClientMessage, FlyEvictedEvent, TableState } from "../shared/protocol";
import { BetPicker } from "./BetPicker";
import { Controls } from "./Controls";
import { FlyEviction } from "./FlyEviction";
import { FlyGlyph } from "./FlyGlyph";
import { Seat } from "./Seat";
import styles from "./Table.module.css";

interface Props {
  state: TableState;
  eviction: FlyEvictedEvent | null;
  bet: number;
  onBetChange: (bet: number) => void;
  send: (message: ClientMessage) => void;
}

export function Table({ state, eviction, bet, onBetChange, send }: Props) {
  const { hands, phase, results, bank, bets, payouts, minBet } = state;
  const betweenRounds = phase === "idle" || phase === "settled";
  const stake = Math.min(bet, bank.player, MAX_BET);
  const canDeal = betweenRounds && !eviction && bank.player >= minBet;

  return (
    <section className={styles.table} aria-label="Game table">
      <div className={styles.dealer}>
        <Seat title="Dealer" subtitle="draws to 17" hand={hands.dealer} active={phase === "dealer"} />
      </div>

      <div className={styles.rule} aria-hidden="true">
        blackjack pays 3 to 2 · dealer stands on 17
      </div>

      <div className={styles.players}>
        <Seat
          title="You"
          hand={hands.player}
          active={phase === "player"}
          result={results.player}
          bet={bets?.player}
          payout={payouts.player}
        />
        <Seat
          title={`Fly #${bank.flyNumber}`}
          subtitle={state.brain.source === "mock" ? "mock brain" : "PyTorch SNN"}
          hand={hands.fly}
          active={phase === "fly"}
          result={results.fly}
          bet={bets?.fly}
          payout={payouts.fly}
          variant="dish"
          avatar={
            <FlyGlyph
              key={bank.flyNumber}
              busy={phase === "fly"}
              drunk={state.drunk}
              enterDelayMs={eviction ? eviction.replayMs * 0.75 : 0}
            />
          }
          overlay={eviction && <FlyEviction key={eviction.newNumber} event={eviction} drunk={state.drunk} />}
        />
      </div>

      <div className={styles.bar}>
        <BetPicker
          bet={stake}
          balance={bank.player}
          minBet={minBet}
          disabled={!betweenRounds || !!eviction}
          inPlay={!betweenRounds}
          onChange={onBetChange}
          onRebuy={() => send({ type: "rebuy" })}
        />
        <Controls phase={phase} roundId={state.roundId} bet={stake} canDeal={canDeal} send={send} />
      </div>
    </section>
  );
}
