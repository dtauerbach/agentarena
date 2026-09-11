export type Speed = number | "max";

export type Pacer = {
  // resolves when simulated time t is reached at the current speed;
  // resolves immediately at speed "max"; blocks while paused (step releases
  // one). isInterrupted is polled during waits — when it turns true the wait
  // returns early WITHOUT reaching t, so the caller can service whatever
  // interrupted it (operator commands) and call waitUntil again.
  waitUntil(t: number, isInterrupted?: () => boolean): Promise<void>;
  setSpeed(speed: Speed): void;
  pause(): void;
  resume(): void;
  step(): void;
  state(): { speed: Speed; paused: boolean; simTime: number };
};

const POLL_MS = 200;

export function makePacer(initialSpeed: Speed): Pacer {
  let speed = initialSpeed;
  let paused = false;
  // anchor maps simulated time to wall clock; re-anchored on speed changes
  let simAnchor = 0;
  let wallAnchor = Date.now();
  let simTime = 0;
  let stepSignal: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  return {
    async waitUntil(t, isInterrupted) {
      for (;;) {
        if (isInterrupted?.()) return; // caller drains and calls again
        if (paused) {
          const released = await new Promise<boolean>((resolve) => {
            stepSignal = () => resolve(true);
            const poll = () => {
              if (!paused || isInterrupted?.()) resolve(false);
              else if (stepSignal) setTimeout(poll, POLL_MS);
            };
            setTimeout(poll, POLL_MS);
          });
          stepSignal = null;
          if (released) break; // one step: process this event now
          if (isInterrupted?.()) return;
          // re-anchor after resume so paused wall time doesn't count
          simAnchor = simTime;
          wallAnchor = Date.now();
          continue;
        }
        if (speed === "max") break;
        const targetWall = wallAnchor + ((t - simAnchor) / speed) * 1000;
        const wait = targetWall - Date.now();
        if (wait <= 0) break;
        await sleep(Math.min(wait, POLL_MS));
      }
      simTime = Math.max(simTime, t);
    },
    setSpeed(next) {
      simAnchor = simTime;
      wallAnchor = Date.now();
      speed = next;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    step() {
      stepSignal?.();
    },
    state() {
      return { speed, paused, simTime };
    },
  };
}
