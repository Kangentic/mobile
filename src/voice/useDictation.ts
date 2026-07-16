import { useCallback, useEffect, useRef, useState } from 'react';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';

/**
 * The dictation engine adapter. Every expo-speech-recognition import stays
 * inside this one file so swapping the speech engine is a one-file change.
 *
 * expo-speech-recognition API used here:
 * - `ExpoSpeechRecognitionModule.isRecognitionAvailable()` - sync engine check.
 * - `ExpoSpeechRecognitionModule.requestPermissionsAsync()` - mic + speech permissions.
 * - `ExpoSpeechRecognitionModule.start({ lang, interimResults })` / `.stop()`.
 * - `useSpeechRecognitionEvent('result' | 'error' | 'start' | 'end', listener)` -
 *   result events carry `{ isFinal, results: [{ transcript, ... }] }`.
 */

export interface UseDictationOptions {
  /** An interim transcript while the user is still speaking. */
  onPartialResult: (text: string) => void;
  /** The final transcript for the utterance. */
  onFinalResult: (text: string) => void;
}

export interface DictationControls {
  /** False when the engine is missing or permission was denied; hide the mic. */
  available: boolean;
  listening: boolean;
  start: () => void;
  stop: () => void;
}

/** BCP-47 tag of the device's default locale, or undefined to let the engine pick its own default. */
function deviceLanguageTag(): string | undefined {
  try {
    const resolvedLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    return resolvedLocale.length > 0 ? resolvedLocale : undefined;
  } catch {
    return undefined;
  }
}

function isRecognitionEngineAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

export function useDictation(options: UseDictationOptions): DictationControls {
  const [available, setAvailable] = useState<boolean>(isRecognitionEngineAvailable);
  const [listening, setListening] = useState(false);
  const permissionGrantedRef = useRef(false);
  // Callbacks live in a ref so event subscriptions never go stale while the
  // caller re-renders with fresh closures.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results[0]?.transcript ?? '';
    if (event.isFinal) {
      optionsRef.current.onFinalResult(transcript);
    } else {
      optionsRef.current.onPartialResult(transcript);
    }
  });

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => setListening(false));

  useSpeechRecognitionEvent('error', (event) => {
    setListening(false);
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      setAvailable(false);
    }
  });

  const start = useCallback(() => {
    void (async () => {
      try {
        if (!permissionGrantedRef.current) {
          const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
          if (!permission.granted) {
            setAvailable(false);
            return;
          }
          permissionGrantedRef.current = true;
        }
        ExpoSpeechRecognitionModule.start({
          lang: deviceLanguageTag(),
          interimResults: true,
        });
      } catch {
        setAvailable(false);
      }
    })();
  }, []);

  const stop = useCallback(() => {
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      setListening(false);
    }
  }, []);

  return { available, listening, start, stop };
}
