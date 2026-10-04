import { describe, expect, it } from 'vitest';
import {
  decodeHostMessage,
  decodeTerminalMessage,
  encodeHostMessage,
  encodeTerminalMessage,
  TERMINAL_FIT_TRIGGERS,
  type HostToTerminalMessage,
  type TerminalToHostMessage,
} from '@/terminal/terminalBridge';

describe('host -> terminal round-trip', () => {
  it('round-trips an init message with known dims and with unknown dims (legacy)', () => {
    const knownDims: HostToTerminalMessage = {
      type: 'init',
      seq: 1,
      scrollback: 'previous output\x1b[32m colored\x1b[0m\n',
      cols: 96,
      rows: 30,
      fitHeightPx: 635,
      theme: { background: '#101014', foreground: '#e6e6e6', cursor: '#e6e6e6', black: '#000000' },
      cleanFeed: false,
      holdFrame: false,
      preservePinch: false,
    };
    expect(decodeHostMessage(encodeHostMessage(knownDims))).toEqual(knownDims);

    const legacy: HostToTerminalMessage = {
      type: 'init',
      seq: 2,
      scrollback: 'plain',
      cols: 80,
      rows: null,
      // The host has not measured the Terminal lens yet: the page falls back.
      fitHeightPx: null,
      theme: {},
      cleanFeed: true,
      holdFrame: true,
      preservePinch: true,
    };
    expect(decodeHostMessage(encodeHostMessage(legacy))).toEqual(legacy);
  });

  /**
   * holdFrame keeps the frame on screen across a swap, and preservePinch keeps
   * a user's zoom across a lens switch back; an init that lost either (an
   * older host against a newer page, or the reverse) must not decode into a
   * choice the sender never made.
   */
  it('rejects an init missing or with a non-boolean holdFrame or preservePinch field', () => {
    const complete = {
      type: 'init',
      seq: 3,
      scrollback: '',
      cols: 80,
      rows: 24,
      fitHeightPx: null,
      theme: {},
      cleanFeed: false,
      holdFrame: true,
      preservePinch: false,
    };
    expect(decodeHostMessage(JSON.stringify(complete))).not.toBeNull();
    const { holdFrame: _holdFrame, ...withoutHoldFrame } = complete;
    expect(decodeHostMessage(JSON.stringify(withoutHoldFrame))).toBeNull();
    expect(decodeHostMessage(JSON.stringify({ ...complete, holdFrame: 'yes' }))).toBeNull();
    const { preservePinch: _preservePinch, ...withoutPreservePinch } = complete;
    expect(decodeHostMessage(JSON.stringify(withoutPreservePinch))).toBeNull();
    expect(decodeHostMessage(JSON.stringify({ ...complete, fitHeightPx: '635' }))).toBeNull();
  });

  /**
   * The fit button's message carries the ring's grid, so a page that inited
   * before the desktop reported one fits the real grid. Unknown dims decode as
   * nulls rather than rejecting the press.
   */
  it('round-trips the refit message with and without the ring grid', () => {
    const withGrid: HostToTerminalMessage = { type: 'refit', cols: 210, rows: 48 };
    expect(decodeHostMessage(encodeHostMessage(withGrid))).toEqual(withGrid);
    const unknownGrid: HostToTerminalMessage = { type: 'refit', cols: null, rows: null };
    expect(decodeHostMessage(encodeHostMessage(unknownGrid))).toEqual(unknownGrid);
    expect(decodeHostMessage('{"type":"refit"}')).toEqual(unknownGrid);
  });

  it('round-trips the fit-height and repaint messages', () => {
    const fitHeight: HostToTerminalMessage = { type: 'fit-height', fitHeightPx: 635 };
    expect(decodeHostMessage(encodeHostMessage(fitHeight))).toEqual(fitHeight);
    expect(decodeHostMessage('{"type":"fit-height","fitHeightPx":"635"}')).toBeNull();
    expect(decodeHostMessage(encodeHostMessage({ type: 'repaint' }))).toEqual({ type: 'repaint' });
  });

  it('round-trips a write message including control bytes', () => {
    const message: HostToTerminalMessage = { type: 'write', data: 'chunk\r\n\x1b[1mBold\x1b[0m' };
    expect(decodeHostMessage(encodeHostMessage(message))).toEqual(message);
  });

  it('round-trips a set-font-size message', () => {
    const message: HostToTerminalMessage = { type: 'set-font-size', fontSizePx: 15 };
    expect(decodeHostMessage(encodeHostMessage(message))).toEqual(message);
  });

  it('round-trips a resize message (the desktop grid the phone adopts, read-only)', () => {
    const resize: HostToTerminalMessage = { type: 'resize', cols: 48, rows: 26 };
    expect(decodeHostMessage(encodeHostMessage(resize))).toEqual(resize);
  });

  it('round-trips a pinch message, active true and active false', () => {
    const pinchStart: HostToTerminalMessage = { type: 'pinch', active: true };
    expect(decodeHostMessage(encodeHostMessage(pinchStart))).toEqual(pinchStart);
    const pinchEnd: HostToTerminalMessage = { type: 'pinch', active: false };
    expect(decodeHostMessage(encodeHostMessage(pinchEnd))).toEqual(pinchEnd);
  });

  it('rejects a pinch message missing or with a non-boolean active field', () => {
    expect(decodeHostMessage('{"type":"pinch"}')).toBeNull();
    expect(decodeHostMessage('{"type":"pinch","active":"yes"}')).toBeNull();
  });
});

describe('terminal -> host round-trip', () => {
  it('round-trips ready and input messages', () => {
    const readyMessage: TerminalToHostMessage = { type: 'ready' };
    const inputMessage: TerminalToHostMessage = { type: 'input', data: '\x1b[A' };
    expect(decodeTerminalMessage(encodeTerminalMessage(readyMessage))).toEqual(readyMessage);
    expect(decodeTerminalMessage(encodeTerminalMessage(inputMessage))).toEqual(inputMessage);
  });

  it('round-trips modes and font-size messages', () => {
    const modes: TerminalToHostMessage = {
      type: 'modes',
      applicationCursorKeys: true,
      mouseTrackingMode: 'any',
      mouseEncoding: 'SGR',
      alternateBuffer: true,
      initial: false,
    };
    expect(decodeTerminalMessage(encodeTerminalMessage(modes))).toEqual(modes);
    const fitReport: TerminalToHostMessage = {
      type: 'font-size',
      fontSizePx: 11,
      source: 'settled',
      trigger: 'init',
      cols: 120,
      rows: 30,
      lineHeight: 1.194,
      fitHeightPx: 635,
      innerHeightPx: 635,
      innerWidthPx: 411,
      gridHeightPx: 396,
      devicePixelRatio: 2.625,
      maxTextureSize: 4096,
    };
    expect(decodeTerminalMessage(encodeTerminalMessage(fitReport))).toEqual(fitReport);
  });

  /**
   * Only the size is required on a fit report: the rest is diagnostic for the
   * release-build trace, and an older page's bare report must still keep the
   * host's pinch baseline in sync.
   */
  it('defaults every diagnostic fit-report field when an older page sends only the size', () => {
    expect(decodeTerminalMessage(JSON.stringify({ type: 'font-size', fontSizePx: 7 }))).toEqual({
      type: 'font-size',
      fontSizePx: 7,
      source: 'unknown',
      trigger: 'unknown',
      cols: null,
      rows: null,
      lineHeight: null,
      fitHeightPx: null,
      innerHeightPx: null,
      innerWidthPx: null,
      gridHeightPx: null,
      devicePixelRatio: null,
      maxTextureSize: null,
    });
  });

  /**
   * The trigger lands in the release-build connection trace, which must never
   * carry free text from the page, so it decodes through a CLOSED set: every
   * member round-trips unchanged and anything else becomes 'unknown', whatever
   * its type.
   *
   * Mutation that reddens this: let decodeFitTrigger pass any string through.
   */
  describe('the fit report trigger is a closed set', () => {
    const decodeTrigger = (trigger: unknown): string | undefined => {
      const decoded = decodeTerminalMessage(JSON.stringify({ type: 'font-size', fontSizePx: 11, trigger }));
      return decoded?.type === 'font-size' ? decoded.trigger : undefined;
    };

    it('round-trips every known trigger unchanged', () => {
      expect(TERMINAL_FIT_TRIGGERS.length).toBeGreaterThan(0);
      for (const trigger of TERMINAL_FIT_TRIGGERS) {
        expect(decodeTrigger(trigger), `trigger ${trigger}`).toBe(trigger);
      }
    });

    it('decodes free text from the page to unknown instead of passing it to the trace', () => {
      expect(decodeTrigger('user typed this')).toBe('unknown');
      expect(decodeTrigger('')).toBe('unknown');
      // Close to a member is still not a member.
      expect(decodeTrigger('Init')).toBe('unknown');
      expect(decodeTrigger('fit-height-x')).toBe('unknown');
    });

    it('decodes a trigger that is not a string to unknown', () => {
      expect(decodeTrigger(42)).toBe('unknown');
      expect(decodeTrigger(null)).toBe('unknown');
      expect(decodeTrigger({ nested: 'init' })).toBe('unknown');
    });
  });

  /**
   * The source is the same kind of seam as the trigger: it lands in the same
   * release-build trace, so it decodes through a closed set too. Both members
   * the page sends round-trip, and anything else is 'unknown'.
   *
   * Mutation that reddens this: let decodeFitSource pass any string through.
   */
  it('decodes the fit report source through a closed set', () => {
    const decodeSource = (fitSource: unknown): string | undefined => {
      const decoded = decodeTerminalMessage(JSON.stringify({ type: 'font-size', fontSizePx: 11, source: fitSource }));
      return decoded?.type === 'font-size' ? decoded.source : undefined;
    };

    expect(decodeSource('settled')).toBe('settled');
    expect(decodeSource('texture-cap')).toBe('texture-cap');
    expect(decodeSource('user typed this')).toBe('unknown');
    expect(decodeSource('Settled')).toBe('unknown');
    expect(decodeSource('')).toBe('unknown');
    expect(decodeSource(7)).toBe('unknown');
    expect(decodeSource(null)).toBe('unknown');
  });

  /**
   * Every numeric diagnostic is primitives only, because the same trace must
   * never carry content from the page: a field that is not a finite number
   * (a string, a boolean, an object; JSON turns Infinity into null) decodes to
   * null rather than reaching the trace as whatever it was.
   *
   * Mutation that reddens this: let finiteNumberOrNull return its argument
   * unchecked.
   */
  it('decodes a diagnostic fit-report field that is not a finite number to null', () => {
    const decoded = decodeTerminalMessage(
      JSON.stringify({
        type: 'font-size',
        fontSizePx: 11,
        cols: '120',
        rows: true,
        lineHeight: { nested: 1.2 },
        fitHeightPx: null,
        innerHeightPx: [640],
        innerWidthPx: 411,
        gridHeightPx: Infinity,
        devicePixelRatio: 'high',
        maxTextureSize: 4096,
      }),
    );

    expect(decoded).toEqual({
      type: 'font-size',
      fontSizePx: 11,
      source: 'unknown',
      trigger: 'unknown',
      cols: null,
      rows: null,
      lineHeight: null,
      fitHeightPx: null,
      innerHeightPx: null,
      innerWidthPx: 411,
      gridHeightPx: null,
      devicePixelRatio: null,
      maxTextureSize: 4096,
    });
  });

  it('round-trips the scroll-latest host message', () => {
    expect(decodeHostMessage(encodeHostMessage({ type: 'scroll-latest' }))).toEqual({ type: 'scroll-latest' });
  });

  /**
   * A page from an older build reports only the DECCKM flag. Dropping the whole
   * message over the three fields it cannot know would lose the arrow-key mode
   * as collateral, so they default instead.
   */
  it('defaults the sticky mode fields when an older page omits them', () => {
    expect(decodeTerminalMessage(JSON.stringify({ type: 'modes', applicationCursorKeys: true }))).toEqual({
      type: 'modes',
      applicationCursorKeys: true,
      mouseTrackingMode: 'none',
      mouseEncoding: 'DEFAULT',
      alternateBuffer: false,
      // Unknown reports count as a baseline: the cost is a missed mode change,
      // versus permanently latching a degraded state the other way.
      initial: true,
    });
  });

  it('round-trips a renderer report (webgl and dom)', () => {
    const webgl: TerminalToHostMessage = { type: 'renderer', renderer: 'webgl' };
    expect(decodeTerminalMessage(encodeTerminalMessage(webgl))).toEqual(webgl);
    const dom: TerminalToHostMessage = { type: 'renderer', renderer: 'dom' };
    expect(decodeTerminalMessage(encodeTerminalMessage(dom))).toEqual(dom);
  });

  it('round-trips clean-lines messages (append and reset)', () => {
    const append: TerminalToHostMessage = { type: 'clean-lines', lines: ['one', 'two'], reset: false };
    expect(decodeTerminalMessage(encodeTerminalMessage(append))).toEqual(append);
    const reset: TerminalToHostMessage = { type: 'clean-lines', lines: [], reset: true };
    expect(decodeTerminalMessage(encodeTerminalMessage(reset))).toEqual(reset);
  });

  it('round-trips the tapped message (keyboard toggle)', () => {
    const tapped: TerminalToHostMessage = { type: 'tapped' };
    expect(decodeTerminalMessage(encodeTerminalMessage(tapped))).toEqual(tapped);
  });

  it('round-trips a painted report, with and without an init seq to attribute it to', () => {
    const attributed: TerminalToHostMessage = { type: 'painted', seq: 4, blank: false };
    expect(decodeTerminalMessage(encodeTerminalMessage(attributed))).toEqual(attributed);
    const unattributed: TerminalToHostMessage = { type: 'painted', seq: null, blank: true };
    expect(decodeTerminalMessage(encodeTerminalMessage(unattributed))).toEqual(unattributed);
  });

  /** A page from a build that predates the seq echo still reports; the host treats an unknown seq as current. */
  it('defaults the painted seq to null when an older page omits it', () => {
    expect(decodeTerminalMessage(JSON.stringify({ type: 'painted', blank: true }))).toEqual({
      type: 'painted',
      seq: null,
      blank: true,
    });
  });
});

describe('decodeTerminalMessage - malformed input', () => {
  it('returns null for non-JSON, non-object, and unknown-type payloads', () => {
    expect(decodeTerminalMessage('not json at all')).toBeNull();
    expect(decodeTerminalMessage('"just a string"')).toBeNull();
    expect(decodeTerminalMessage('42')).toBeNull();
    expect(decodeTerminalMessage('null')).toBeNull();
    expect(decodeTerminalMessage('[]')).toBeNull();
    expect(decodeTerminalMessage('{}')).toBeNull();
    expect(decodeTerminalMessage('{"type":"launch-missiles"}')).toBeNull();
    // fit-dims was removed: the phone never proposes a resize anymore.
    expect(decodeTerminalMessage('{"type":"fit-dims","cols":44,"rows":22}')).toBeNull();
  });

  it('returns null for an input message with a missing or non-string data field', () => {
    expect(decodeTerminalMessage('{"type":"input"}')).toBeNull();
    expect(decodeTerminalMessage('{"type":"input","data":7}')).toBeNull();
  });

  it('returns null for malformed modes, font-size, and renderer messages', () => {
    expect(decodeTerminalMessage('{"type":"modes","applicationCursorKeys":"yes"}')).toBeNull();
    expect(decodeTerminalMessage('{"type":"font-size","fontSizePx":"7"}')).toBeNull();
    expect(decodeTerminalMessage('{"type":"renderer","renderer":"vulkan"}')).toBeNull();
    expect(decodeTerminalMessage('{"type":"renderer"}')).toBeNull();
  });

  it('returns null for malformed clean-lines messages', () => {
    expect(decodeTerminalMessage('{"type":"clean-lines","lines":["a",1],"reset":false}')).toBeNull();
    expect(decodeTerminalMessage('{"type":"clean-lines","lines":"a","reset":false}')).toBeNull();
    expect(decodeTerminalMessage('{"type":"clean-lines","lines":[]}')).toBeNull();
  });

  it('returns null for a painted report whose blank flag is missing or not a boolean', () => {
    expect(decodeTerminalMessage('{"type":"painted","seq":1}')).toBeNull();
    expect(decodeTerminalMessage('{"type":"painted","seq":1,"blank":"no"}')).toBeNull();
  });
});

describe('decodeHostMessage - malformed input', () => {
  it('returns null for non-JSON and unknown-type payloads', () => {
    expect(decodeHostMessage('{nope')).toBeNull();
    expect(decodeHostMessage('{"type":"reboot"}')).toBeNull();
    // set-fit-mode was removed: there are no modes to switch anymore.
    expect(decodeHostMessage('{"type":"set-fit-mode","fitMode":"fit"}')).toBeNull();
  });

  it('returns null for an init message with wrong or missing fields', () => {
    expect(
      decodeHostMessage('{"type":"init","scrollback":"x","cols":"80","rows":null,"fontSizePx":13,"theme":{}}'),
    ).toBeNull();
    expect(
      decodeHostMessage('{"type":"init","scrollback":"x","cols":80,"rows":null,"fontSizePx":13,"theme":{"a":1}}'),
    ).toBeNull();
    expect(
      decodeHostMessage('{"type":"init","scrollback":"x","cols":80,"rows":null,"fontSizePx":13,"theme":[]}'),
    ).toBeNull();
    expect(decodeHostMessage('{"type":"init","scrollback":"x","fontSizePx":13,"theme":{}}')).toBeNull();
    // No seq: the page could not attribute its painted report to this init.
    expect(
      decodeHostMessage(
        '{"type":"init","scrollback":"x","cols":80,"rows":null,"fontSizePx":13,"theme":{},"cleanFeed":false}',
      ),
    ).toBeNull();
  });

  it('returns null for write, set-font-size, and resize messages with wrong field types', () => {
    expect(decodeHostMessage('{"type":"write","data":123}')).toBeNull();
    expect(decodeHostMessage('{"type":"write"}')).toBeNull();
    expect(decodeHostMessage('{"type":"set-font-size","fontSizePx":"12"}')).toBeNull();
    expect(decodeHostMessage('{"type":"resize","cols":48}')).toBeNull();
  });
});
