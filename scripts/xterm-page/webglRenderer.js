  // Ported from the desktop renderer's terminal-webgl.ts. xterm's WebGL renderer
  // is 10-50x faster than the DOM fallback for output bursts. The GPU can drop
  // the context (driver reset, memory pressure); the naive "dispose on loss"
  // permanently reverts to the DOM renderer, so every later burst becomes slow.
  // Instead, on a loss we RETRY re-init with a backoff, and only give up (DOM for
  // good) after the retries are exhausted. The desktop's per-page WebGL attach
  // budget / LRU coordinator is deliberately omitted: a phone hosts exactly one
  // xterm per WebView, so it never approaches Chromium's per-page context cap.
  var WEBGL_RETRY_DELAYS_MS = [2000, 10000];

  function attachWebgl() {
    if (!terminal) return false;
    try {
      var addon = new window.WebglAddon.WebglAddon();
      addon.onContextLoss(handleWebglContextLoss);
      terminal.loadAddon(addon);
      webglAddon = addon;
      return true;
    } catch (webglError) {
      // WebGL unavailable in this WebView (no GPU / blocklisted): DOM stays.
      webglAddon = null;
      return false;
    }
  }

  function handleWebglContextLoss() {
    if (webglAddon) {
      try { webglAddon.dispose(); } catch (disposeError) { /* may already be gone */ }
      webglAddon = null;
    }
    reportRenderer(); // now on the DOM renderer until (and unless) a retry recovers WebGL
    webglLossCount += 1;
    if (webglLossCount > WEBGL_RETRY_DELAYS_MS.length) return; // give up: DOM renderer for good
    if (webglRetryTimer !== null) clearTimeout(webglRetryTimer);
    webglRetryTimer = setTimeout(function () {
      webglRetryTimer = null;
      attachWebgl();
      reportRenderer();
    }, WEBGL_RETRY_DELAYS_MS[webglLossCount - 1]);
  }

  function resetWebglState() {
    if (webglRetryTimer !== null) {
      clearTimeout(webglRetryTimer);
      webglRetryTimer = null;
    }
    // A fresh createTerminal disposed the old terminal (and its addon) already.
    webglAddon = null;
    webglLossCount = 0;
  }

  // Report the active renderer to the host (like the desktop's renderer report),
  // so a degraded terminal is observable rather than a silent DOM fallback.
  function reportRenderer() {
    postToHost({ type: 'renderer', renderer: webglAddon ? 'webgl' : 'dom' });
  }

