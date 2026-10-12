import type { RecordedTerminalCapture } from './recordedTerminal';

/**
 * RECORDED Claude Code output. Do not hand-edit - regenerate with:
 *   node scripts/buildTerminalFixture.mjs --capture <file> --cols 66 --rows 48 \
 *     --grid-cols 210 --grid-rows 48 --seed-end <N> --end <N - 1> --export COMMAND_TERMINAL_SUBMITTED
 *
 * Recorded at 66x48 from a real session against a throwaway
 * storefront fixture repo, then widened to the 210x48 grid the mock
 * announces (scripts/terminalFrame.mjs): rules and diff bands run to the new
 * edge, every recorded cell stays where it was.
 *
 * The prose is a customer's work rather than this product's. See
 * scripts/captureClaudeFrames.mjs for how, and why the recording environment
 * matters.
 */
export const COMMAND_TERMINAL_SUBMITTED: RecordedTerminalCapture = {
  cols: 210,
  rows: 48,
  seedFrame:
    '\x1b[?1049h\x1b[H\x1b[?7l\r\n \x1b[38;2;215;119;87m▐\x1b[48;2;0;0;0m▛███▛█\x1b[0m   \x1b[1mClaude\x1b[0m \x1b[1mCode\x1b[0m \x1b[38;2;153;153;153mv2.1.296\x1b[0m\r\n\x1b[38;2;215;119;87m▝▜\x1b[48;2;0;0;0m█████\x1b[49m█▀\x1b[0m  \x1b[38;2;153;153;153mOpus\x1b[0m \x1b[38;2;153;153;153m5.5\x1b[0m \x1b[38;2;153;153;153mwith\x1b[0m \x1b[38;2;153;153;153mhigh\x1b[0m \x1b[38;2;153;153;153meffort\x1b[0m \x1b[38;2;153;153;153m·\x1b[0m \x1b[38;2;153;153;153mClaude\x1b[0m \x1b[38;2;153;153;153mMax\x1b[0m\r\n \x1b[38;2;215;119;87m▝▝\x1b[0m   \x1b[38;2;215;119;87m▝▝\x1b[0m   \x1b[38;2;153;153;153m~\\code\\storefront-web\x1b[0m\r\n\r\n\r\n\x1b[38;2;153;153;153;48;2;55;55;55m❯ \x1b[38;2;255;255;255mWhich routes send a signed-out user to the login page? Short                                                                                                                                                    \x1b[0m\r\n\x1b[48;2;55;55;55m  \x1b[38;2;255;255;255manswer.                                                                                                                                                                                                         \x1b[0m\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\x1b[38;2;215;119;87m✻\x1b[1CAcco\x1b[38;2;235;159;127mmpl\x1b[38;2;215;119;87mishing…\x1b[0m\r\n                                                \x1b[38;2;153;153;153m●\x1b[0m \x1b[38;2;153;153;153mhigh\x1b[0m \x1b[38;2;153;153;153m·\x1b[0m \x1b[38;2;153;153;153m/effort\x1b[0m\r\n\x1b[38;2;136;136;136m──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\x1b[0m\r\n\x1b[38;2;153;153;153m❯ \x1b[0m\r\n\x1b[38;2;136;136;136m──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\x1b[0m\r\n  \x1b[38;2;153;153;153m⏸\x1b[0m \x1b[38;2;153;153;153mmanual\x1b[0m \x1b[38;2;153;153;153mmode\x1b[0m \x1b[38;2;153;153;153mon\x1b[0m \x1b[38;2;153;153;153m·\x1b[0m \x1b[38;2;153;153;153mesc\x1b[0m \x1b[38;2;153;153;153mto\x1b[0m \x1b[38;2;153;153;153minterrupt\x1b[0m \x1b[38;2;153;153;153m·\x1b[0m \x1b[38;2;153;153;153m←\x1b[0m \x1b[38;2;153;153;153m1\x1b[0m \x1b[38;2;153;153;153magent\x1b[0m\x1b[?7h\r\x1b[2A\x1b[2C\x1b[?2004h\x1b[?1004h\x1b[?1003h',
  chunks: [],
};
