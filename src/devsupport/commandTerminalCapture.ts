import { COMMAND_TERMINAL_ANSWERED } from './commandTerminalAnswered';
import { COMMAND_TERMINAL_OPENING } from './commandTerminalOpening';
import { COMMAND_TERMINAL_SUBMITTED } from './commandTerminalSubmitted';
import type { RecordedTerminalCapture } from './recordedTerminal';

/**
 * One RECORDED Command Terminal turn: three settled frames of a single real
 * Claude Code session, which the mock desktop's Command Terminals replay in
 * place of anything authored. A terminal opens on the first, a prompt shows
 * the second, and the turn ends on the third, which is the 07-command-terminal
 * store frame.
 *
 * The frames are generated (scripts/buildTerminalFixture.mjs, one seed-only
 * fixture each, every one widened from 66x48 to the 210x48 grid the mock
 * announces); this module only names them and records how they were taken.
 * The recipe is in the header of scripts/captureClaudeFrames.mjs.
 *
 * Only three, and not a stream, because nothing else in the turn is clean:
 * from about a second after the prompt is submitted until the answer settles,
 * Claude Code's status area carries the recording account's weekly usage,
 * which the builder refuses. And only these three, because a widened fixture
 * must be seed-only: a chunk recorded at 66 columns paints the wrong cells in
 * a 210-column grid.
 */
export interface RecordedCommandTerminalTurn {
  /** Claude Code's opening screen: the header and an empty prompt. */
  readonly opening: RecordedTerminalCapture;
  /** The moment after the prompt was submitted, the spinner up. */
  readonly submitted: RecordedTerminalCapture;
  /** The settled answer. */
  readonly answered: RecordedTerminalCapture;
}

export const COMMAND_TERMINAL_TURN: RecordedCommandTerminalTurn = {
  opening: COMMAND_TERMINAL_OPENING,
  submitted: COMMAND_TERMINAL_SUBMITTED,
  answered: COMMAND_TERMINAL_ANSWERED,
};

/** The prompt the recorded session was asked, exactly as typed. Its frames show it. */
export const COMMAND_TERMINAL_RECORDED_PROMPT = 'Which routes send a signed-out user to the login page? Short answer.';

/**
 * The name a real desktop gave a Command Terminal asked that prompt: its
 * namer (src/main/agent/shared/command-terminal-namer.ts in the desktop repo)
 * summarized it with the terminal's own agent, read back off a phone paired to
 * that desktop on 2026-10-12. Not composed here.
 */
export const COMMAND_TERMINAL_RECORDED_NAME = 'Identify Routes That Redirect Signed-Out Users to Login';

/** How long the recorded turn took, as its own answer reports it ("Cogitated for 11s"). */
export const COMMAND_TERMINAL_RECORDED_TURN_MS = 11_000;
