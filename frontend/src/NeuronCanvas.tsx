import { useEffect, useRef } from "react";
import type { DopamineEvent, NeuronGroupId, ThinkEvent, Topology } from "../shared/protocol";
import styles from "./NeuronCanvas.module.css";
import type { ActivityBus } from "./useGame";

export type ReplayProgress =
  | { kind: "think"; event: ThinkEvent; hit: number; stand: number; done: boolean }
  | { kind: "dopamine"; event: DopamineEvent; done: boolean };

interface Props {
  topology: Topology;
  activity: ActivityBus;
  /** Show spontaneous background firing between decisions. */
  idle: boolean;
  onReplay: (progress: ReplayProgress) => void;
}

const GROUP_ORDER: NeuronGroupId[] = ["input", "kc", "mbon_hit", "mbon_stand", "pam", "ppl1"];

const LABELS: { text: string; x: number; y: number }[] = [
  { text: "input", x: 0.07, y: 0.045 },
  { text: "Kenyon cells", x: 0.43, y: 0.045 },
  { text: "PAM +", x: 0.83, y: 0.045 },
  { text: "MBON hit", x: 0.83, y: 0.255 },
  { text: "MBON stand", x: 0.83, y: 0.745 },
  { text: "PPL1 −", x: 0.83, y: 0.975 },
];

interface Layout {
  x: Float32Array;
  y: Float32Array;
  group: Uint8Array;
  mbonHit: [number, number];
  mbonStand: [number, number];
}

function buildLayout(topology: Topology): Layout {
  const { count } = topology;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const group = new Uint8Array(count);
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const range: Record<string, [number, number]> = {};

  const cluster = (start: number, size: number, cx: number, cy: number, cols: number) => {
    const rows = Math.ceil(size / cols);
    for (let i = 0; i < size; i++) {
      x[start + i] = cx + ((i % cols) - (cols - 1) / 2) * 0.03;
      y[start + i] = cy + (Math.floor(i / cols) - (rows - 1) / 2) * 0.04;
    }
  };

  for (const g of topology.groups) {
    group.fill(GROUP_ORDER.indexOf(g.id), g.start, g.start + g.size);
    range[g.id] = [g.start, g.start + g.size];
    switch (g.id) {
      case "input":
        for (let i = 0; i < g.size; i++) {
          x[g.start + i] = 0.07;
          y[g.start + i] = 0.1 + (0.82 * i) / Math.max(1, g.size - 1);
        }
        break;
      case "kc": {
        const cols = Math.ceil(Math.sqrt(g.size * 0.75));
        const rows = Math.ceil(g.size / cols);
        for (let i = 0; i < g.size; i++) {
          const cx = (i % cols) + 0.5 + (rand() - 0.5) * 0.7;
          const cy = Math.floor(i / cols) + 0.5 + (rand() - 0.5) * 0.7;
          x[g.start + i] = 0.19 + (0.48 * cx) / cols;
          y[g.start + i] = 0.09 + (0.84 * cy) / rows;
        }
        break;
      }
      case "mbon_hit":
        cluster(g.start, g.size, 0.83, 0.37, 4);
        break;
      case "mbon_stand":
        cluster(g.start, g.size, 0.83, 0.63, 4);
        break;
      case "pam":
        cluster(g.start, g.size, 0.83, 0.12, 5);
        break;
      case "ppl1":
        cluster(g.start, g.size, 0.83, 0.88, 5);
        break;
    }
  }

  return {
    x,
    y,
    group,
    mbonHit: range.mbon_hit ?? [0, 0],
    mbonStand: range.mbon_stand ?? [0, 0],
  };
}

function readColors(el: Element) {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const amber = v("--amber");
  return {
    base: v("--ink-faint"),
    label: v("--ink-dim"),
    line: v("--scope-line"),
    font: v("--font-mono"),
    // same order as GROUP_ORDER
    groups: [amber, amber, amber, amber, v("--reward"), v("--punish")],
  };
}

interface Playback {
  kind: "think" | "dopamine";
  event: ThinkEvent | DopamineEvent;
  start: number;
  applied: number;
  hit: number;
  stand: number;
}

export function NeuronCanvas({ topology, activity, idle, onReplay }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const idleRef = useRef(idle);
  const onReplayRef = useRef(onReplay);
  const kickRef = useRef<() => void>(() => {});

  useEffect(() => {
    onReplayRef.current = onReplay;
  }, [onReplay]);

  useEffect(() => {
    idleRef.current = idle;
    kickRef.current();
  }, [idle]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const layout = buildLayout(topology);
    const glow = new Float32Array(topology.count);
    const colors = readColors(canvas);
    const queue: Playback[] = [];
    let playback: Playback | null = null;
    let raf = 0;
    let last = performance.now();
    let lastIdle = 0;
    let width = 0;
    let height = 0;

    const report = (p: Playback, done: boolean) => {
      if (p.kind === "think") {
        onReplayRef.current({ kind: "think", event: p.event as ThinkEvent, hit: p.hit, stand: p.stand, done });
      } else {
        onReplayRef.current({ kind: "dopamine", event: p.event as DopamineEvent, done });
      }
    };

    const applyFrame = (p: Playback) => {
      const frame = p.event.frames[p.applied++] ?? [];
      for (const n of frame) {
        glow[n] = 1;
        if (n >= layout.mbonHit[0] && n < layout.mbonHit[1]) p.hit++;
        else if (n >= layout.mbonStand[0] && n < layout.mbonStand[1]) p.stand++;
      }
    };

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const r = Math.max(1.3, width * 0.0042);

      ctx.font = `${Math.max(9, width * 0.019)}px ${colors.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = colors.label;
      for (const label of LABELS) ctx.fillText(label.text, label.x * width, label.y * height);

      // resting neurons in one path
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = colors.base;
      ctx.beginPath();
      for (let i = 0; i < topology.count; i++) {
        const px = (layout.x[i] ?? 0) * width;
        const py = (layout.y[i] ?? 0) * height;
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, Math.PI * 2);
      }
      ctx.fill();

      // firing neurons on top
      for (let i = 0; i < topology.count; i++) {
        const g = glow[i] ?? 0;
        if (g < 0.04) continue;
        const px = (layout.x[i] ?? 0) * width;
        const py = (layout.y[i] ?? 0) * height;
        ctx.fillStyle = colors.groups[layout.group[i] ?? 0] ?? colors.base;
        ctx.globalAlpha = g * 0.22;
        ctx.beginPath();
        ctx.arc(px, py, r * 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, 0.25 + g);
        ctx.beginPath();
        ctx.arc(px, py, r * (1 + g * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      raf = 0;
      const dt = Math.min(100, now - last);
      last = now;
      const decay = Math.exp(-dt / 160);
      let lit = false;
      for (let i = 0; i < glow.length; i++) {
        const g = (glow[i] ?? 0) * decay;
        glow[i] = g;
        if (g > 0.04) lit = true;
      }

      // A newer event is waiting (e.g. the tab was hidden): finish this one at once.
      if (playback && queue.length > 0) {
        while (playback.applied < playback.event.frames.length) applyFrame(playback);
        report(playback, true);
        playback = null;
      }
      if (!playback) {
        const next = queue.shift();
        if (next) {
          next.start = now;
          playback = next;
        }
      }
      if (playback) {
        const { frames, replayMs } = playback.event;
        const frameMs = replayMs / Math.max(1, frames.length);
        const due = Math.min(frames.length, Math.floor((now - playback.start) / frameMs) + 1);
        if (playback.applied < due) {
          while (playback.applied < due) applyFrame(playback);
          report(playback, false);
        }
        if (playback.applied >= frames.length && now - playback.start >= replayMs) {
          report(playback, true);
          playback = null;
        }
        lit = true;
      }

      if (idleRef.current && now - lastIdle > 70) {
        lastIdle = now;
        const n = Math.ceil(topology.count * 0.004);
        for (let k = 0; k < n; k++) {
          const i = Math.floor(Math.random() * topology.count);
          glow[i] = Math.max(glow[i] ?? 0, 0.5);
        }
      }

      draw();
      if (lit || playback || queue.length > 0 || idleRef.current) raf = requestAnimationFrame(tick);
    };

    const kick = () => {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    kickRef.current = kick;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const unsubscribe = activity.subscribe((a) => {
      queue.push({ kind: a.kind, event: a.event, start: 0, applied: 0, hit: 0, stand: 0 });
      kick();
    });
    kick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      unsubscribe();
      kickRef.current = () => {};
    };
  }, [topology, activity]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.canvas}
      role="img"
      aria-label="Fly neuron activity: input, Kenyon cells, MBON output neurons for hit and stand, PAM and PPL1 dopamine neurons"
    />
  );
}
