// Emits a diagnostic for a given key at most once, so unusual-but-recurring
// conditions (an unsupported scope, an unmappable emoji, missing
// credentials) produce one log line instead of spamming per message.
export type OnceLogger = (key: string, message: string) => void;

export function createOnceLogger(logFn: (message: string) => void, maxKeys = 50): OnceLogger {
  const seenKeys = new Set<string>();
  return (key: string, message: string) => {
    if (seenKeys.has(key)) {
      return;
    }
    if (seenKeys.size >= maxKeys) {
      // Bounded: an adversarial or unexpectedly diverse key space must not
      // grow this set without limit.
      return;
    }
    seenKeys.add(key);
    logFn(message);
  };
}
