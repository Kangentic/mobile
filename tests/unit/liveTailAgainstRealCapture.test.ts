/**
 * The live-tail cleaner, against REAL Claude Code output.
 *
 * src/terminal/liveTail.ts carries a whole classifier vocabulary for terminal
 * chrome - box drawing, braille and `✻`-family spinners, `N tokens` status,
 * `esc to interrupt`, middot-joined context bars, `Tip:` hints - and until the
 * mock replayed a recorded capture, nothing in this repo ever fed it a single
 * byte an agent had actually emitted. Its unit tests used hand-written strings
 * shaped like the thing it was meant to strip, which tests the regex against
 * itself.
 *
 * This is the third surface of the fixture rebuild: the chat lens's reading-view
 * fallback exists to DELETE chrome, so parity here means the cleaner correctly
 * strips real Claude chrome, not that the chrome survives.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { CLAUDE_CAPTURE_SHOTS } from '@/devsupport/claudeCapture';
import { createLiveTailBuffer, lastContentLineFromScrollback } from '@/terminal/liveTail';
import { renderCaptureRows } from '../helpers/renderCapture';

/** Chrome the reading view must never show. */
const BOX_DRAWING = /[╭╮╰╯│─═║╔╗╚╝╌]/;
const SPINNER_STATUS = /esc to interrupt|\bworking\s*\(|\bsketching/i;
const CONTEXT_BAR = /·.*·|[↑↓].*\d/;
const TIP_HINT = /^tip:\s/i;

describe('the live-tail cleaner against a recorded Claude Code session', () => {
  let tailLines: string[] = [];

  beforeAll(async () => {
    // Feed the capture through exactly as the app does: the seed frame first,
    // then every streamed chunk, in order, through the same buffer instance so
    // escape sequences split across chunk boundaries resume correctly.
    const buffer = createLiveTailBuffer();
    buffer.append(CLAUDE_CAPTURE_SHOTS.seedFrame);
    for (const chunk of CLAUDE_CAPTURE_SHOTS.chunks) buffer.append(chunk.data);
    tailLines = buffer.snapshotLines();
  });

  it('produces a non-empty tail, so the assertions below are not vacuous', () => {
    expect(tailLines.length).toBeGreaterThan(0);
  });

  it('never leaks an escape sequence into the reading view', () => {
    // The reading view renders as plain text; a stray CSI would show as
    // literal "[38;2;215m" mid-sentence.
    for (const line of tailLines) expect(line).not.toMatch(/\x1b/);
  });

  it('strips the box drawing, spinner, context bar and tip chrome', () => {
    const leaked = tailLines.filter(
      (line) =>
        BOX_DRAWING.test(line) || SPINNER_STATUS.test(line) || CONTEXT_BAR.test(line) || TIP_HINT.test(line),
    );
    expect(leaked).toEqual([]);
  });

  it('reads as the agent working, not as terminal furniture', () => {
    // The point of the lens: something a person could actually read. Real
    // Claude Code marks its tool calls and results with these glyphs, and the
    // recorded session is a file edit, so at least one has to survive cleaning.
    const readable = tailLines.filter((line) => line.trim().length > 0);
    expect(readable.length).toBeGreaterThan(0);
    expect(readable.join('\n')).toMatch(/[●⏺⎿]|\b(Update|Edit|Write|Read|Bash)\b|\w{4,}\s+\w{4,}/);
  });
});

describe('the feed snippet against a recorded Claude Code session', () => {
  it('picks a readable line out of a real frame, not chrome', async () => {
    const rows = await renderCaptureRows(CLAUDE_CAPTURE_SHOTS);
    // lastContentLineFromScrollback walks BACKWARDS from the newest output,
    // which on this capture lands in the middle of a live permission dialog -
    // the hardest case, because the dialog's own furniture is the last thing
    // drawn.
    const snippet = lastContentLineFromScrollback(rows.join('\n'));

    expect(snippet).not.toBeNull();
    expect(snippet ?? '').not.toMatch(BOX_DRAWING);
    expect(snippet ?? '').not.toMatch(SPINNER_STATUS);
    expect(snippet ?? '').not.toMatch(CONTEXT_BAR);
    // Not a bare label either: the classifier's whole job is to skip worktree
    // tags, branch names and lone paths in favour of something that reads.
    expect((snippet ?? '').trim().length).toBeGreaterThan(3);
  });
});
