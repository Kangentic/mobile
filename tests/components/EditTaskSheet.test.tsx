import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { EditTaskSheet } from '@/components/board/EditTaskSheet';
import { boardTaskFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

// DictationTextField pulls in the dictation engine.
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn().mockReturnValue(false),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: false }),
    start: jest.fn(),
    stop: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(),
}));

function renderSheet(onSave: jest.Mock): void {
  render(
    <ThemeProvider>
      <EditTaskSheet
        visible
        task={boardTaskFixture({ id: 'task-1', title: 'Original title', description: 'Original description' })}
        onClose={jest.fn()}
        onSave={onSave}
        saveInFlight={false}
        errorMessage={null}
      />
    </ThemeProvider>,
  );
}

describe('EditTaskSheet', () => {
  it('prefills the current values and gates save on dirtiness', () => {
    const onSave = jest.fn();
    renderSheet(onSave);
    expect(screen.getByTestId('edit-task-title').props.value).toBe('Original title');
    expect(screen.getByTestId('edit-task-description').props.value).toBe('Original description');

    // Unchanged: save is disabled.
    fireEvent.press(screen.getByTestId('edit-task-save'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('sends only the changed fields', () => {
    const onSave = jest.fn();
    renderSheet(onSave);
    fireEvent.changeText(screen.getByTestId('edit-task-title'), 'Renamed title');
    fireEvent.press(screen.getByTestId('edit-task-save'));
    expect(onSave).toHaveBeenCalledWith({ title: 'Renamed title' });
  });

  it('never saves an empty title', () => {
    const onSave = jest.fn();
    renderSheet(onSave);
    fireEvent.changeText(screen.getByTestId('edit-task-title'), '   ');
    fireEvent.press(screen.getByTestId('edit-task-save'));
    expect(onSave).not.toHaveBeenCalled();
  });
});
