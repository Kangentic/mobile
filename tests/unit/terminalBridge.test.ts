import { describe, expect, it } from 'vitest';
import {
  decodeHostMessage,
  decodeTerminalMessage,
  encodeHostMessage,
  encodeTerminalMessage,
  type HostToTerminalMessage,
  type TerminalToHostMessage,
} from '@/terminal/terminalBridge';

describe('host -> terminal round-trip', () => {
  it('round-trips an init message with known dims and with unknown dims (legacy)', () => {
    const knownDims: HostToTerminalMessage = {
      type: 'init',
      scrollback: 'previous output\x1b[32m colored\x1b[0m\n',
      cols: 96,
      rows: 30,
      fontSizePx: 13,
      theme: { background: '#101014', foreground: '#e6e6e6', cursor: '#e6e6e6', black: '#000000' },
      cleanFeed: false,
    };
    expect(decodeHostMessage(encodeHostMessage(knownDims))).toEqual(knownDims);

    const legacy: HostToTerminalMessage = {
      type: 'init',
      scrollback: 'plain',
      cols: 80,
      rows: null,
      fontSizePx: 12,
      theme: {},
      cleanFeed: true,
    };
    expect(decodeHostMessage(encodeHostMessage(legacy))).toEqual(legacy);
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
    const fontSize: TerminalToHostMessage = { type: 'font-size', fontSizePx: 7 };
    expect(decodeTerminalMessage(encodeTerminalMessage(fontSize))).toEqual(fontSize);
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

  it('round-trips the refit host message (snap back to the fitted view)', () => {
    expect(decodeHostMessage(encodeHostMessage({ type: 'refit' }))).toEqual({ type: 'refit' });
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
  });

  it('returns null for write, set-font-size, and resize messages with wrong field types', () => {
    expect(decodeHostMessage('{"type":"write","data":123}')).toBeNull();
    expect(decodeHostMessage('{"type":"write"}')).toBeNull();
    expect(decodeHostMessage('{"type":"set-font-size","fontSizePx":"12"}')).toBeNull();
    expect(decodeHostMessage('{"type":"resize","cols":48}')).toBeNull();
  });
});
