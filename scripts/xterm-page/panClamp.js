  // A refit can SHRINK the grid (the soft keyboard halves the viewport
  // height, so the height-fitted font drops and the frame narrows). The
  // horizontal pan is not automatically reconciled, so a scrollLeft from the
  // wider layout can now point past the end of the content and the screen
  // renders BLANK. Clamp it to what the new content allows, then put the
  // cursor back in view.
  //
  // Live-verified failure this fixes: opening the keyboard in the terminal
  // (which the prompt cards' "More options in terminal" hatch does directly)
  // left scrollLeft at 706 against a 723-wide grid in a 411-wide viewport -
  // 2.3x past the maximum useful scroll - showing an empty frame.
  function clampHorizontalPan() {
    var container = scrollContainer();
    if (!container) return;
    // Still showing the opening view: hold column 0 so a relayout (the soft
    // keyboard, rotation) cannot drift the frame off the left edge before
    // the user has panned anywhere themselves.
    if (pinnedToStart) {
      container.scrollLeft = 0;
      return;
    }
    // Clamp against the RENDERED GRID width, never container.scrollWidth: a
    // shrinking refit leaves stale wider children inside #terminal, so
    // scrollWidth keeps authorizing scroll far past the last column.
    // Measured live on a Pixel 10 with the keyboard up: grid 723 CSS px but
    // container.scrollWidth still 1366, so a scrollLeft of 706 counted as
    // "in bounds" while showing an empty frame.
    var screen = document.querySelector('.xterm-screen') || document.querySelector('.xterm');
    var contentWidth = screen ? screen.getBoundingClientRect().width : container.scrollWidth;
    var maxScrollLeft = Math.max(0, contentWidth - container.clientWidth);
    if (container.scrollLeft > maxScrollLeft) container.scrollLeft = maxScrollLeft;
  }

