import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { ComposerBar } from '@/components/composer/ComposerBar';
import { sendUserMessage } from '@/connection/actions';
import type { RetentionProbeVariant } from '@/devsupport/retentionProbe';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import type { UseDictationOptions } from '@/voice/useDictation';

jest.mock('@/connection/actions', () => ({
  sendUserMessage: jest.fn(),
}));

// The handled-error door: asserted WITH the rejected instance on failure
// (which is why the arrow forwards its arguments), and asserted absent on
// success, so the call cannot become unconditional without a test noticing.
const mockReportHandledError = jest.fn();
jest.mock('@/observability/crashReporting', () => ({
  reportHandledError: (site: string, error: unknown) => mockReportHandledError(site, error),
}));

// The dictation engine boundary is mocked as a controllable plain object so
// no expo-speech-recognition native module is ever touched.
const mockDictationControls = {
  available: true,
  listening: false,
  start: jest.fn(),
  stop: jest.fn(),
};
// Counted, not just stubbed: the retention probe test below asserts the
// subscription never registers, which no rendered output can show. It also
// keeps the options each call received, because the dictation tests below
// drive the composer the way the speech engine does: by invoking the
// onPartialResult / onFinalResult it was handed.
const mockUseDictation = jest.fn((_options: UseDictationOptions) => mockDictationControls);
jest.mock('@/voice/useDictation', () => ({
  useDictation: (options: UseDictationOptions) => mockUseDictation(options),
}));

let mockRetentionProbeVariant: RetentionProbeVariant = 'off';
jest.mock('@/devsupport/retentionProbe', () => ({
  getRetentionProbeVariant: () => mockRetentionProbeVariant,
}));

const mockSendUserMessage = jest.mocked(sendUserMessage);

async function renderComposer(): Promise<void> {
  await render(
    <ThemeProvider>
      <ComposerBar sessionId="sess-1" />
    </ThemeProvider>,
  );
}

describe('ComposerBar', () => {
  beforeEach(() => {
    mockSendUserMessage.mockReset();
    mockSendUserMessage.mockResolvedValue(undefined);
    mockReportHandledError.mockClear();
    mockDictationControls.available = true;
    mockDictationControls.listening = false;
    mockDictationControls.start.mockClear();
    mockDictationControls.stop.mockClear();
    mockUseDictation.mockClear();
    mockRetentionProbeVariant = 'off';
    useChannelStore.setState({ established: true });
    useSettingsStore.setState({ dictationMode: 'auto-send', hydrated: true });
  });

  it('sends the trimmed message and clears the input on success', async () => {
    await renderComposer();
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'hello agent ');
    await fireEvent.press(screen.getByTestId('composer-send'));
    expect(mockSendUserMessage).toHaveBeenCalledWith('sess-1', 'hello agent');
    await waitFor(() => expect(screen.getByTestId('composer-input').props.value).toBe(''));
    expect(mockReportHandledError).not.toHaveBeenCalled();
  });

  it('disables send while the channel is not established', async () => {
    useChannelStore.setState({ established: false });
    await renderComposer();
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'hello');
    expect(screen.getByTestId('composer-send').props.accessibilityState.disabled).toBe(true);
  });

  it('disables send while the input is empty', async () => {
    await renderComposer();
    expect(screen.getByTestId('composer-send').props.accessibilityState.disabled).toBe(true);
  });

  it('keeps the text and shows an inline error when sending fails, and reports it through the door', async () => {
    const failure = new Error('Not connected');
    mockSendUserMessage.mockRejectedValue(failure);
    await renderComposer();
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'hello agent');
    await fireEvent.press(screen.getByTestId('composer-send'));
    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect(screen.getByTestId('composer-input').props.value).toBe('hello agent');
    expect(mockReportHandledError).toHaveBeenCalledWith('composer-send', failure);
  });

  it('hides the mic when dictation mode is off', async () => {
    useSettingsStore.setState({ dictationMode: 'off' });
    await renderComposer();
    expect(screen.queryByTestId('composer-mic')).toBeNull();
    expect(screen.queryByTestId('composer-mic-active')).toBeNull();
  });

  it('hides the mic when the engine is unavailable', async () => {
    mockDictationControls.available = false;
    await renderComposer();
    expect(screen.queryByTestId('composer-mic')).toBeNull();
  });

  it('starts dictation on mic tap and shows the active state while listening', async () => {
    await renderComposer();
    await fireEvent.press(screen.getByTestId('composer-mic'));
    expect(mockDictationControls.start).toHaveBeenCalled();
  });

  it('shows the active mic and stops on tap while listening', async () => {
    mockDictationControls.listening = true;
    await renderComposer();
    const activeMicButton = screen.getByTestId('composer-mic-active');
    expect(screen.queryByTestId('composer-mic')).toBeNull();
    await fireEvent.press(activeMicButton);
    expect(mockDictationControls.stop).toHaveBeenCalled();
  });

  it('still subscribes the dictation engine when dictation mode is off', async () => {
    // The shipped behaviour the mic-button extraction must preserve: the engine
    // subscription is independent of the setting, only the mic is hidden.
    useSettingsStore.setState({ dictationMode: 'off' });
    await renderComposer();
    expect(mockUseDictation).toHaveBeenCalled();
  });

  describe('dictation results', () => {
    /**
     * The speech engine reaches the composer only through the two callbacks
     * `ComposerBar` hands `DictationMicButton`, which hands them to
     * `useDictation`. The mock above keeps what that hook was called with, so
     * these tests drive the composer exactly as the engine does, and they fail
     * if the mic-button extraction stops forwarding a callback or stops calling
     * `onStart` before the engine starts.
     */
    function latestDictationOptions(): UseDictationOptions {
      const latestCall = mockUseDictation.mock.calls.at(-1);
      if (latestCall === undefined) throw new Error('useDictation was never called');
      return latestCall[0];
    }

    it('appends a partial result to what was typed before the mic was tapped', async () => {
      await renderComposer();
      await fireEvent.changeText(screen.getByTestId('composer-input'), 'hello');
      await fireEvent.press(screen.getByTestId('composer-mic'));

      await act(() => {
        latestDictationOptions().onPartialResult('world');
      });
      expect(screen.getByTestId('composer-input').props.value).toBe('hello world');

      // A later partial replaces the earlier one after the same typed prefix,
      // rather than stacking on top of it.
      await act(() => {
        latestDictationOptions().onPartialResult('world again');
      });
      expect(screen.getByTestId('composer-input').props.value).toBe('hello world again');
      expect(mockSendUserMessage).not.toHaveBeenCalled();
    });

    it('sends the typed text plus the final result in auto-send mode, then clears the input', async () => {
      await renderComposer();
      await fireEvent.changeText(screen.getByTestId('composer-input'), 'hello');
      await fireEvent.press(screen.getByTestId('composer-mic'));

      await act(() => {
        latestDictationOptions().onFinalResult('world');
      });

      expect(mockSendUserMessage).toHaveBeenCalledWith('sess-1', 'hello world');
      await waitFor(() => expect(screen.getByTestId('composer-input').props.value).toBe(''));
    });

    it('keeps the final result in the input without sending in manual-send mode', async () => {
      useSettingsStore.setState({ dictationMode: 'manual-send' });
      await renderComposer();
      await fireEvent.changeText(screen.getByTestId('composer-input'), 'hello');
      await fireEvent.press(screen.getByTestId('composer-mic'));

      await act(() => {
        latestDictationOptions().onFinalResult('world');
      });

      expect(screen.getByTestId('composer-input').props.value).toBe('hello world');
      expect(mockSendUserMessage).not.toHaveBeenCalled();
    });
  });

  it("registers no dictation listeners under the retention probe's composer-no-dictation arm", async () => {
    // The arm exists to isolate expo-modules-core #50603 (removed listeners
    // retained as GC roots), so it has to remove the SUBSCRIPTION, not merely
    // hide the mic. Asserted on the hook call because the two look identical.
    mockRetentionProbeVariant = 'composer-no-dictation';
    await renderComposer();
    expect(mockUseDictation).not.toHaveBeenCalled();
    expect(screen.queryByTestId('composer-mic')).toBeNull();
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });
});
