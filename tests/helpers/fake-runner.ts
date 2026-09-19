import type {
  RunController,
  RunEvent,
  RunEventType,
  RunState,
} from '../../src/dashboard/run-controller.js';

/**
 * A RunController that records calls and emits events on demand.
 *
 * The routes are what these tests are about; starting the real pipeline would
 * make them slow, network-dependent and unable to test a mid-run reconnect.
 */
export interface FakeRunner extends RunController {
  started: unknown[];
  cancelled: number;
  allowStart: boolean;
  failReason: string;
  push(type: RunEventType, data: unknown): RunEvent;
  setState(patch: Partial<RunState>): void;
}

export function createFakeRunner(): FakeRunner {
  const listeners = new Set<(event: RunEvent) => void>();
  const buffer: RunEvent[] = [];
  let seq = 0;

  let state: RunState = {
    running: false,
    runId: null,
    startedAt: null,
    finishedAt: null,
    progress: null,
    cancelling: false,
    lastSummary: null,
    lastError: null,
    lastEventId: 0,
  };

  const runner: FakeRunner = {
    started: [],
    cancelled: 0,
    allowStart: true,
    failReason: 'a run is already in progress',

    state: () => ({ ...state, lastEventId: seq }),
    events: (sinceSeq = 0) => buffer.filter((event) => event.seq > sinceSeq),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start(request) {
      if (!runner.allowStart) return { started: false, reason: runner.failReason };
      runner.started.push(request);
      state = { ...state, running: true, startedAt: new Date().toISOString() };
      return { started: true };
    },

    cancel() {
      if (!state.running) return false;
      runner.cancelled += 1;
      state = { ...state, cancelling: true };
      return true;
    },

    push(type, data) {
      seq += 1;
      const event: RunEvent = { seq, type, at: new Date().toISOString(), data };
      buffer.push(event);
      for (const listener of listeners) listener(event);
      return event;
    },

    setState(patch) {
      state = { ...state, ...patch };
    },
  };

  return runner;
}
