/**
 * The RN <-> WebView postMessage protocol for the xterm terminal pane:
 * message types, encoding, and validating decoding. No WebView imports; the
 * generated xterm.html glue and the RN host both consume this module, and
 * both treat the boundary as untrusted-ish (anything malformed decodes to
 * null and is dropped).
 *
 * The pane is a FAITHFUL MIRROR: it renders the desktop's exact grid 1:1 and
 * NEVER resizes the desktop PTY (a shared session must not be reshaped by the
 * phone). It sizes the font so the whole frame fits the phone screen, and
 * pinch-zoom + pan read the detail. `rows: null` on init means the desktop
 * never reported its grid (pre-0.4.0) - the glue then infers cols from
 * content and fits rows to the viewport until the real dims arrive.
 *
 * The theme record maps xterm ITheme keys (black, red, ..., brightWhite,
 * background, foreground, cursor) to hex color strings. It stays a plain
 * Record<string, string> so this module never depends on the app theme type
 * or on xterm's own typings.
 */

export type HostToTerminalMessage =
  | {
      type: 'init';
      scrollback: string;
      cols: number;
      /** The PTY's rows, or null when the desktop never reported dims (legacy inference). */
      rows: number | null;
      fontSizePx: number;
      theme: Record<string, string>;
    }
  | { type: 'write'; data: string }
  | { type: 'set-font-size'; fontSizePx: number }
  /** The authoritative PTY grid changed (desktop refit); adopt it and re-fit the frame to screen. */
  | { type: 'resize'; cols: number; rows: number };

export type TerminalToHostMessage =
  | { type: 'ready' }
  | { type: 'input'; data: string }
  /** DECCKM report: arrows need SS3 (application cursor mode) instead of CSI. */
  | { type: 'modes'; applicationCursorKeys: boolean }
  /** The glue changed the font size autonomously (fit-to-screen zoom); keeps the host's pinch base in sync. */
  | { type: 'font-size'; fontSizePx: number };

export function encodeHostMessage(message: HostToTerminalMessage): string {
  return JSON.stringify(message);
}

export function encodeTerminalMessage(message: TerminalToHostMessage): string {
  return JSON.stringify(message);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  for (const entryValue of Object.values(value)) {
    if (typeof entryValue !== 'string') {
      return false;
    }
  }
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Decode a message received FROM the WebView terminal; null on anything malformed. */
export function decodeTerminalMessage(raw: string): TerminalToHostMessage | null {
  const parsedObject = parseJsonObject(raw);
  if (parsedObject === null) {
    return null;
  }
  if (parsedObject.type === 'ready') {
    return { type: 'ready' };
  }
  if (parsedObject.type === 'input' && typeof parsedObject.data === 'string') {
    return { type: 'input', data: parsedObject.data };
  }
  if (parsedObject.type === 'modes' && typeof parsedObject.applicationCursorKeys === 'boolean') {
    return { type: 'modes', applicationCursorKeys: parsedObject.applicationCursorKeys };
  }
  if (parsedObject.type === 'font-size' && isFiniteNumber(parsedObject.fontSizePx)) {
    return { type: 'font-size', fontSizePx: parsedObject.fontSizePx };
  }
  return null;
}

/**
 * Decode a message sent TO the WebView terminal. Used by the generated
 * xterm.html glue and by tests to round-trip encodeHostMessage.
 */
export function decodeHostMessage(raw: string): HostToTerminalMessage | null {
  const parsedObject = parseJsonObject(raw);
  if (parsedObject === null) {
    return null;
  }
  if (parsedObject.type === 'write' && typeof parsedObject.data === 'string') {
    return { type: 'write', data: parsedObject.data };
  }
  if (parsedObject.type === 'set-font-size' && isFiniteNumber(parsedObject.fontSizePx)) {
    return { type: 'set-font-size', fontSizePx: parsedObject.fontSizePx };
  }
  if (parsedObject.type === 'resize' && isFiniteNumber(parsedObject.cols) && isFiniteNumber(parsedObject.rows)) {
    return { type: 'resize', cols: parsedObject.cols, rows: parsedObject.rows };
  }
  if (
    parsedObject.type === 'init' &&
    typeof parsedObject.scrollback === 'string' &&
    isFiniteNumber(parsedObject.cols) &&
    (parsedObject.rows === null || isFiniteNumber(parsedObject.rows)) &&
    isFiniteNumber(parsedObject.fontSizePx) &&
    isStringRecord(parsedObject.theme)
  ) {
    return {
      type: 'init',
      scrollback: parsedObject.scrollback,
      cols: parsedObject.cols,
      rows: parsedObject.rows === null ? null : parsedObject.rows,
      fontSizePx: parsedObject.fontSizePx,
      theme: parsedObject.theme,
    };
  }
  return null;
}
