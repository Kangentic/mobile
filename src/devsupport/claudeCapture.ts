import type { RecordedTerminalCapture } from './recordedTerminal';

/**
 * RECORDED Claude Code output. Do not hand-edit - regenerate with:
 *   node scripts/buildTerminalFixture.mjs --capture <file> --cols 44 --rows 38 \
 *     --seed-end <n> --end <n> --export CLAUDE_CAPTURE_SHOTS
 *
 * Captured at 44x38 from a real session against a throwaway
 * storefront fixture repo, so the prose is a customer's work rather than this
 * product's. See scripts/captureClaudeFrames.mjs for how, and why the
 * recording environment matters.
 */
export const CLAUDE_CAPTURE_SHOTS: RecordedTerminalCapture = {
  cols: 44,
  rows: 38,
  seedFrame:
    '\x1b[?1049h\x1b[H                                            \r\n     \x1b[38;2;153;153;153mfeedback\x1b[0m                               \r\n                                            \x1b[38;2;255;255;255m●\x1b[0m Both are real. Applying the SSR guard and \r\n  the hash:                                 \r\n                                            \x1b[38;2;153;153;153m●\x1b[0m \x1b[1mUpdate\x1b[0m(\x1b[4msrc\\routes\\checkout.tsx\x1b[0m)           \r\n                                            \x1b[38;2;177;185;249m────────────────────────────────────────────\r\n\x1b[0m \x1b[38;2;177;185;249;1mEdit file\x1b[0m                                  \r\n \x1b[38;2;153;153;153msrc\\routes\\checkout.tsx                    \x1b[38;2;80;80;80m╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\x1b[38;2;248;248;242;2m  5 \x1b[22m   \x1b[38;2;102;217;239mconst \x1b[38;2;248;248;242muser = \x1b[38;2;166;226;46museUser\x1b[38;2;248;248;242m();              \x1b[2m  6 \x1b[22m \x1b[0m                                       \r\n\x1b[38;2;248;248;242;2m  7 \x1b[22m   \x1b[38;2;249;38;114mif \x1b[38;2;248;248;242m(!user) {                         -\x1b[1D\x1b[1X\x1b[38;2;220;90;90;48;2;61;1;0m  8 -    \x1b[38;2;248;248;242mreturn loginRedirect(window.locatio\x1b[38;2;220;90;90m    -\x1b[38;2;248;248;242mn.pathname + window.location.search);  -\x1b[1D\x1b[1X\x1b[38;2;80;200;80;48;2;2;40;0m  8 +    \x1b[38;2;117;113;94m// Empty on the server; loginRedire\x1b[38;2;80;200;80m    +\x1b[38;2;117;113;94mct falls back to a plain /login in that\x1b[38;2;80;200;80m    + \x1b[38;2;117;113;94mcase.                                 \x1b[38;2;80;200;80m  9 +    \x1b[38;2;102;217;239mconst \x1b[38;2;248;248;242m{ pathname, search, hash } = \x1b[38;2;80;200;80m    +\x1b[38;2;249;38;114mtypeof \x1b[38;2;255;255;255mwindow \x1b[38;2;248;248;242m=== \x1b[38;2;230;219;116m"undefined" \x1b[38;2;248;248;242m? \x1b[38;2;255;255;255mEMPTY_L\x1b[38;2;80;200;80m    +\x1b[38;2;255;255;255mOCATION \x1b[38;2;248;248;242m: \x1b[38;2;255;255;255mwindow\x1b[38;2;248;248;242m.\x1b[38;2;255;255;255mlocation\x1b[38;2;248;248;242m;             \x1b[38;2;80;200;80m 10 +    \x1b[38;2;249;38;114mreturn \x1b[38;2;166;226;46mloginRedirect\x1b[38;2;248;248;242m(pathname + sea\x1b[38;2;80;200;80m    +\x1b[38;2;248;248;242mrch + hash);                           -\x1b[1D\x1b[1X\x1b[49;2m 11 \x1b[22m   }                                    \x1b[2m 12 \x1b[22m                                        \x1b[2m 13 \x1b[22m   \x1b[38;2;249;38;114mreturn \x1b[38;2;248;248;242m<CheckoutSummary \x1b[38;2;166;226;46muser\x1b[38;2;248;248;242m=\x1b[38;2;230;219;116m{user} \x1b[38;2;248;248;242m/\x1b[2m    \x1b[22m >;\x1b[0m                                     \r\n\x1b[38;2;80;80;80m╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\x1b[0m Do you want to make this edit to           \r\n \x1b[1mcheckout.tsx\x1b[0m?                               \x1b[38;2;177;185;249m❯\x1b[0m \x1b[38;2;153;153;153m1. \x1b[38;2;177;185;249mYes\r\n\x1b[3C\x1b[38;2;153;153;153m2. \x1b[0mYes,\x1b[1Callow\x1b[1Call\x1b[1Cedits\x1b[1Cduring\x1b[1Cthis\r\n      session \x1b[1m(shift+tab)\x1b[0m                     \x1b[1C\x1b[38;2;153;153;153m3. \x1b[0mNo\r\n                                            \r\n\x1b[1C\x1b[38;2;153;153;153mEsc to cancel · Tab to amend\x1b[9A\x1b[22D\x1b[0m\x1b[?2004h\x1b[?1004h\x1b[?1003h',
  chunks: [
    { offsetMs: 0, data: '\x1b[?2026h\x1b[?2026l' },
  ],
};
