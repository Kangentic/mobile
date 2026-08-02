  function postToHost(message) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  function scrollContainer() {
    return document.getElementById('scroll-container');
  }

  function fallbackRowCount(fontSizePx) {
    // Only used before the desktop's rows are known: a rough guess so the
    // first paint is close, corrected when the real grid arrives.
    var approximateCellHeight = Math.ceil(fontSizePx * 1.35);
    return Math.max(8, Math.floor(window.innerHeight / approximateCellHeight));
  }

  function resizePreservingBottom(cols, rows) {
    if (cols === terminal.cols && rows === terminal.rows) return;
    var buffer = terminal.buffer.active;
    var wasAtBottom = buffer.viewportY >= buffer.baseY;
    terminal.resize(cols, rows);
    // Follow-tail only when the user was already at the bottom; a reader
    // scrolled up into history must never be yanked back down by a refit.
    if (wasAtBottom) terminal.scrollToBottom();
  }

