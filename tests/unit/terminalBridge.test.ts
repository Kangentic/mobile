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
  it('round-trips an init message', () => {
    const message: HostToTerminalMessage = {
      type: 'init',
      scrollback: 'previous output\x1b[32m colored\x1b[0m\n',
      cols: 96,
      fontSizePx: 13,
      theme: { background: '#101014', foreground: '#e6e6e6', cursor: '#e6e6e6', black: '#000000' },
    };
    expect(decodeHostMessage(encodeHostMessage(message))).toEqual(message);
  });

  it('round-trips a write message including control bytes', () => {
    const message: HostToTerminalMessage = { type: 'write', data: 'chunk\r\n\x1b[1mBold\x1b[0m' };
    expect(decodeHostMessage(encodeHostMessage(message))).toEqual(message);
  });

  it('round-trips a set-font-size message', () => {
    const message: HostToTerminalMessage = { type: 'set-font-size', fontSizePx: 15 };
    expect(decodeHostMessage(encodeHostMessage(message))).toEqual(message);
  });
});

describe('terminal -> host round-trip', () => {
  it('round-trips ready and input messages', () => {
    const readyMessage: TerminalToHostMessage = { type: 'ready' };
    const inputMessage: TerminalToHostMessage = { type: 'input', data: '\x1b[A' };
    expect(decodeTerminalMessage(encodeTerminalMessage(readyMessage))).toEqual(readyMessage);
    expect(decodeTerminalMessage(encodeTerminalMessage(inputMessage))).toEqual(inputMessage);
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
  });

  it('returns null for an input message with a missing or non-string data field', () => {
    expect(decodeTerminalMessage('{"type":"input"}')).toBeNull();
    expect(decodeTerminalMessage('{"type":"input","data":7}')).toBeNull();
  });
});

describe('decodeHostMessage - malformed input', () => {
  it('returns null for non-JSON and unknown-type payloads', () => {
    expect(decodeHostMessage('{nope')).toBeNull();
    expect(decodeHostMessage('{"type":"reboot"}')).toBeNull();
  });

  it('returns null for an init message with wrong field types', () => {
    expect(
      decodeHostMessage(
        '{"type":"init","scrollback":"x","cols":"80","fontSizePx":13,"theme":{}}',
      ),
    ).toBeNull();
    expect(
      decodeHostMessage('{"type":"init","scrollback":"x","cols":80,"fontSizePx":13,"theme":{"a":1}}'),
    ).toBeNull();
    expect(
      decodeHostMessage('{"type":"init","scrollback":"x","cols":80,"fontSizePx":13,"theme":[]}'),
    ).toBeNull();
    expect(decodeHostMessage('{"type":"init","cols":80,"fontSizePx":13,"theme":{}}')).toBeNull();
  });

  it('returns null for write and set-font-size messages with wrong field types', () => {
    expect(decodeHostMessage('{"type":"write","data":123}')).toBeNull();
    expect(decodeHostMessage('{"type":"write"}')).toBeNull();
    expect(decodeHostMessage('{"type":"set-font-size","fontSizePx":"12"}')).toBeNull();
  });
});
