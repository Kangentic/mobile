  // --- Clean feed ---------------------------------------------------------
  // Hand-mirrors src/terminal/cleanFeedDiff.ts (this page cannot import TS);
  // tests/unit/cleanFeedDiff extracts this copy from the generated file and
  // asserts both implementations agree, so they cannot drift silently.
  function diffCleanLines(previousLines, serialized) {
    var newLines = serialized.split('\n').map(function (line) { return line.replace(/\s+$/, ''); });
    while (newLines.length > 0 && newLines[newLines.length - 1] === '') {
      newLines.pop();
    }
    var commonPrefixLength = 0;
    var comparableLength = Math.min(newLines.length, previousLines.length);
    for (var index = 0; index < comparableLength; index += 1) {
      if (newLines[index] === previousLines[index]) commonPrefixLength += 1;
      else break;
    }
    if (commonPrefixLength === newLines.length && newLines.length === previousLines.length) {
      return { lines: [], reset: false, nextLines: newLines };
    }
    var reset = commonPrefixLength < previousLines.length;
    var candidateLines = reset ? newLines : newLines.slice(commonPrefixLength);
    var decorative = /^[\u2500-\u257F\s\-=_\u00B7\u2022]+$/;
    var emitted = candidateLines.filter(function (line) {
      return line.length > 0 && !decorative.test(line);
    });
    return { lines: emitted, reset: reset, nextLines: newLines };
  }

  function teardownCleanFeed() {
    if (cleanDebounceTimer !== null) {
      clearTimeout(cleanDebounceTimer);
      cleanDebounceTimer = null;
    }
    if (cleanTerminal) {
      try { cleanTerminal.dispose(); } catch (disposeError) { /* already gone */ }
      cleanTerminal = null;
    }
    cleanLastLines = [];
  }

  function setupCleanFeed(colsForClean, rowsForClean) {
    teardownCleanFeed();
    if (!cleanFeedEnabled) return;
    cleanTerminal = new HeadlessXterm.Terminal({
      cols: colsForClean,
      rows: rowsForClean,
      scrollback: CLEAN_FEED_SCROLLBACK,
      allowProposedApi: true,
    });
  }

  // The parsed frame as PLAIN cell text: every buffer line (scrollback +
  // screen) via translateToString(trimRight) - escape codes never reach
  // cells, so the reading view gets pure text by construction. Fullscreen
  // TUIs live in the ALT buffer, and buffer.active follows them, which is
  // exactly what a reader wants to read.
  function cleanFeedFrameText() {
    var activeBuffer = cleanTerminal.buffer.active;
    var frameLines = [];
    for (var lineIndex = 0; lineIndex < activeBuffer.length; lineIndex += 1) {
      var bufferLine = activeBuffer.getLine(lineIndex);
      frameLines.push(bufferLine ? bufferLine.translateToString(true) : '');
    }
    return frameLines.join('\n');
  }

  function cleanFeedWrite(data) {
    if (!cleanTerminal || typeof data !== 'string' || data.length === 0) return;
    cleanTerminal.write(data);
    if (cleanDebounceTimer !== null) clearTimeout(cleanDebounceTimer);
    cleanDebounceTimer = setTimeout(flushCleanFeed, CLEAN_FEED_DEBOUNCE_MS);
  }

  function flushCleanFeed() {
    cleanDebounceTimer = null;
    if (!cleanTerminal) return;
    // xterm parses write() asynchronously; a zero-length write's callback is
    // the flush barrier (the desktop's headless frame buffer uses the same).
    cleanTerminal.write('', function () {
      if (!cleanTerminal) return;
      var frameText;
      try {
        frameText = cleanFeedFrameText();
      } catch (frameError) {
        return;
      }
      var result = diffCleanLines(cleanLastLines, frameText);
      cleanLastLines = result.nextLines;
      if (result.lines.length === 0 && !result.reset) return;
      postToHost({ type: 'clean-lines', lines: result.lines, reset: result.reset });
    });
  }
  // --- end clean feed -----------------------------------------------------

