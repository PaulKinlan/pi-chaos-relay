/**
 * Debounced persistence for the poller's resume state (cursor + de-dup log).
 *
 * The poller reports a state change for every accepted batch, and a WebSocket
 * push frame is usually one message, so writing each report synchronously is one
 * disk write per inbound message (bead pi-chaos-relay-7jp). A burst of N messages
 * is N writes, all but the last of which describe a state that is immediately
 * superseded.
 *
 * Not all staleness is equal, and that is the whole design:
 *
 *  - State that is merely OLDER than memory is harmless. A restart re-reads a
 *    little backlog and the de-dup log filters the rest, so routine cursor and
 *    de-dup updates are staged and written on a timer or at the next drain edge.
 *  - State that is NEWER than disk in the wrong direction is not: when a batch is
 *    handed BACK for a replacement session (session_shutdown, a stale runtime),
 *    the replacement reads the persisted cursor and de-dup log, so the rewound
 *    cursor MUST be on disk before it does. That is `stageUrgent`, which writes
 *    synchronously, and it is why this class has two entry points instead of one.
 *
 * `dispose()` is the other half of the same rule: a superseded instance must not
 * flush its (older) state over the replacement's, so after dispose this writer
 * writes nothing at all.
 */

/** Safety-net flush interval: bounds how much de-dup state a hard kill can lose. */
export const DEFAULT_FLUSH_INTERVAL_MS = 2_000;

export interface DebouncedStateWriterOptions<State> {
  /** The synchronous write. May throw; the failure is reported, not swallowed. */
  write: (state: State) => void;
  /** Timer flush interval. Default {@link DEFAULT_FLUSH_INTERVAL_MS}. */
  intervalMs?: number;
  /** Called when `write` throws; the state stays dirty so the next flush retries. */
  onError?: (err: unknown) => void;
}

export class DebouncedStateWriter<State> {
  private pending: State | undefined;
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private readonly write: (state: State) => void;
  private readonly onError: (err: unknown) => void;

  /** Completed writes. Tests and evidence read this to show coalescing. */
  writeCount = 0;

  constructor(opts: DebouncedStateWriterOptions<State>) {
    this.write = opts.write;
    this.onError = opts.onError ?? (() => {});
    const intervalMs = opts.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.timer = setInterval(() => this.flushNow(), intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** The newest state, for the next flush. Cheap: no I/O. */
  stage(state: State): void {
    if (this.disposed) return;
    this.pending = state;
    this.dirty = true;
  }

  /**
   * Stage and write NOW. For state another process will read before this one is
   * asked again — the hand-back path (see the module comment).
   */
  stageUrgent(state: State): void {
    this.stage(state);
    this.flushNow();
  }

  /**
   * Write the staged state if there is any. A failed write keeps the state dirty
   * so the next flush retries it, and never throws at the caller: persistence is
   * best-effort on the message path and must not become an uncaughtException.
   */
  flushNow(): void {
    if (!this.dirty || this.disposed) return;
    const state = this.pending as State;
    try {
      this.write(state);
    } catch (err) {
      this.onError(err);
      return;
    }
    this.dirty = false;
    this.writeCount += 1;
  }

  /** True when a flush would write something. */
  get hasPending(): boolean {
    return this.dirty && !this.disposed;
  }

  /** Stop the timer and refuse further writes (a superseded instance). */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
