/**
 * Replay of a RECORDED Claude Code PTY capture.
 *
 * The data these types describe is produced by `scripts/captureClaudeFrames.mjs`
 * (a real `claude` process under a real PTY) and packed by
 * `scripts/buildTerminalFixture.mjs`. Nothing here is authored terminal output,
 * which is the point: the app's terminal lens, its live-tail cleaner, and the
 * store screenshots all only exercise the chrome an agent actually emits if the
 * fixture actually contains it.
 *
 * These are fixture shapes, not wire shapes, so they are declared here rather
 * than taken from `@kangentic/protocol` - nothing on the wire carries a capture.
 */

/** One recorded PTY write, at its offset from the start of the replay window. */
export interface RecordedTerminalChunk {
  readonly offsetMs: number;
  readonly data: string;
}

export interface RecordedTerminalCapture {
  /** The PTY grid the capture was recorded at. Replaying at any other grid reflows it wrongly. */
  readonly cols: number;
  readonly rows: number;
  /**
   * A self-contained escape-sequence frame reconstructing the screen as it
   * stood when the replay window opens, carrying its own alt-screen and mode
   * preamble. Mirrors what a real desktop sends as the read-stream snapshot's
   * scrollback, and exists because Claude Code repaints incrementally: the
   * chunk stream alone would render as fragments.
   */
  readonly seedFrame: string;
  readonly chunks: readonly RecordedTerminalChunk[];
}

export interface RecordedTerminalPlayback {
  stop(): void;
}

/**
 * Play a capture back on its RECORDED timing.
 *
 * Cadence is load-bearing. Claude Code bursts while a turn streams and goes
 * silent during a tool call, and that rhythm is most of what separates a live
 * terminal from a script being typed out at a fixed rate. Emitting one line per
 * tick reads as a fixture however real the bytes are.
 *
 * A single self-rescheduling timer drains every chunk that has come due, rather
 * than one timer per chunk: a capture is hundreds of chunks, and a burst can
 * put dozens in the same frame.
 */
export function playRecordedTerminal(
  capture: RecordedTerminalCapture,
  onChunk: (data: string) => void,
  options?: { readonly startDelayMs?: number },
): RecordedTerminalPlayback {
  const startDelayMs = options?.startDelayMs ?? 0;
  const startedAt = Date.now() + startDelayMs;
  let nextChunkIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pump = (): void => {
    timer = null;
    const elapsedMs = Date.now() - startedAt;

    let batched = '';
    while (nextChunkIndex < capture.chunks.length && capture.chunks[nextChunkIndex].offsetMs <= elapsedMs) {
      batched += capture.chunks[nextChunkIndex].data;
      nextChunkIndex += 1;
    }
    if (batched.length > 0) onChunk(batched);

    if (nextChunkIndex >= capture.chunks.length) return;
    const waitMs = Math.max(0, capture.chunks[nextChunkIndex].offsetMs - (Date.now() - startedAt));
    timer = setTimeout(pump, waitMs);
  };

  timer = setTimeout(pump, Math.max(0, startDelayMs));

  return {
    stop(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      nextChunkIndex = capture.chunks.length;
    },
  };
}
