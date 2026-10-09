// Minimal observable store. State is treated as immutable: always replace slices, never mutate.

/**
 * @template S
 * @param {S} initialState
 */
export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  return {
    /** @returns {S} */
    get: () => state,

    /**
     * Shallow-merge a patch into state and notify subscribers synchronously.
     * @param {Partial<S> | ((s: S) => Partial<S>)} patch
     */
    set(patch) {
      const prev = state;
      const next = typeof patch === 'function' ? patch(prev) : patch;
      if (!next) return;
      let changed = false;
      for (const key of Object.keys(next)) {
        if (!Object.is(prev[key], next[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...prev, ...next };
      for (const listener of [...listeners]) listener(state, prev);
    },

    /**
     * Subscribe to every change. Returns an unsubscribe function.
     * @param {(state: S, prev: S) => void} listener
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Subscribe to a derived slice; `onChange` runs only when the selected value changes (Object.is).
     * With `{ immediate: true }` it also runs once right away.
     * @template T
     * @param {(state: S) => T} selector
     * @param {(value: T, prevValue: T | undefined, state: S) => void} onChange
     * @param {{ immediate?: boolean }} [opts]
     */
    select(selector, onChange, opts = {}) {
      let current = selector(state);
      if (opts.immediate) onChange(current, undefined, state);
      const listener = (s) => {
        const next = selector(s);
        if (Object.is(next, current)) return;
        const prev = current;
        current = next;
        onChange(next, prev, s);
      };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
