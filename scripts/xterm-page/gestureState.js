  // Clean-tap detection (tap toggles the host-side keyboard; drags, pans,
  // and pinches never do): a single touch that ends within the slop radius
  // and time budget posts 'tapped' to the host. Any second finger or real
  // movement marks the gesture dirty.
  var TAP_SLOP_PX = 12;
  var TAP_MAX_MS = 350;
  var tapStartX = 0;
  var tapStartY = 0;
  var tapStartAt = 0;
  var tapDirty = true;
  // Moving reference point for history scrolling (see consumeHistoryDrag). Null
  // whenever the gesture is not a single finger, so a pinch never scrolls.
  var historyDragAnchorY = null;
  // Fixed start of the gesture, used only to decide the axis (the anchor above
  // moves as travel is consumed, so it cannot answer "how far overall").
  var historyDragStartX = 0;
  // 'vertical' | 'horizontal' | null, latched once per gesture.
  var historyDragAxis = null;
  // Travel before the axis is decided. Matches the tap slop, so the same small
  // movement that still counts as a tap also commits to no axis.
  var DRAG_AXIS_SLOP_PX = 12;
  // Momentum state: the velocity window's samples, the generation that cancels
  // an in-flight glide (same pattern as heightFitGeneration), and the stats
  // the dev probe reports.
  var dragSamples = [];
  var flingGeneration = 0;
  var flingStats = { started: 0, totalUnits: 0 };
  // How many re-seeds took the in-place reset vs a full DOM rebuild; the dev
  // probe's way to verify the reset button stopped hard-flashing.
  var initCounts = { hard: 0, soft: 0 };
  // How far back THIS PHONE has scrolled the shared view (net units toward
  // history since the last tail anchor) and when the user last scrolled.
  // Diagnostics for the probe - "is the mirror scrolled back, and whose fault
  // is it" was previously unanswerable from outside.
  var netHistoryUnits = 0;
  var lastUserScrollAt = 0;
  // Armed by a jump: the redraw it triggers is a full-frame burst, exactly
  // the paint the Android WebView renderer sometimes drops (black terminal
  // until a 1px scroll). The first write after a jump forces a whole-canvas
  // repaint once flushed. Counted for the probe.
  var pendingJumpRepaint = false;
  var jumpRepaintCount = 0;
  // Jump timeline for the probe: when the jump was sent, how long until its
  // redraw came back (null = nothing arrived, the blank-frame case), and how
  // many render nudges went out.
  var lastJumpAt = null;
  var lastJumpFirstWriteMs = null;
  var jumpNudgeCount = 0;

