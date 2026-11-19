import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import {
  applyFlush,
  discard as discardItem,
  EMPTY_QUEUE,
  enqueue as enqueueItem,
  flush,
  parseQueue,
  pendingCount,
  prune,
  retry as retryItem,
  type QueueState,
  type TimeEntryRow,
} from "../lib/timeQueue";
import { sendTimeEntry } from "../lib/timeEntriesCloud";
import { useSupabase } from "./useWorkspace";

/**
 * Keeps the time-entry outbox (lib/timeQueue.ts) on the phone and sends it:
 * when the app opens, when it comes back to the front, right after a save,
 * and every 30 seconds while something is waiting.
 */

const STORAGE_KEY = "namaa.timeQueue.v1";
const RETRY_MS = 30_000;

interface TimeQueueApi {
  state: QueueState;
  loaded: boolean;
  sending: boolean;
  save(row: TimeEntryRow): void;
  retry(uuid: string): void;
  discard(uuid: string): void;
  sendNow(): void;
}

const TimeQueueContext = createContext<TimeQueueApi | null>(null);

export function useTimeQueue(): TimeQueueApi {
  const api = useContext(TimeQueueContext);
  if (!api) throw new Error("TimeQueueProvider missing");
  return api;
}

export function TimeQueueProvider({ serverNow, children }: { serverNow: () => Promise<number>; children: ReactNode }) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const [state, setState] = useState<QueueState>(EMPTY_QUEUE);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  // The latest queue, for code that runs after an await.
  const stateRef = useRef(state);
  const busy = useRef(false);

  const commit = useCallback((update: (current: QueueState) => QueueState) => {
    const next = update(stateRef.current);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    // Written before anything is sent, so a queued entry survives the app closing.
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);

  const sendNow = useCallback(async () => {
    if (busy.current || pendingCount(stateRef.current) === 0) return;
    busy.current = true;
    setSending(true);
    try {
      const result = await flush(stateRef.current, {
        serverNow,
        deviceNow: () => Date.now(),
        send: (row) => sendTimeEntry(client, row),
      });
      commit((current) => applyFlush(current, result, new Date().toISOString()));
      if (result.outcomes.some((entry) => entry.outcome.kind === "ok")) {
        void queryClient.invalidateQueries({ queryKey: ["time-entries"] });
      }
    } finally {
      busy.current = false;
      setSending(false);
    }
  }, [client, commit, queryClient, serverNow]);

  // Load the stored queue, then try to send it.
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(STORAGE_KEY)
      .catch(() => null)
      .then((raw) => {
        if (cancelled) return;
        const stored = prune(parseQueue(raw), Date.now());
        stateRef.current = stored;
        setState(stored);
        setLoaded(true);
        void sendNow();
      });
    return () => {
      cancelled = true;
    };
  }, [sendNow]);

  // Back in the front: signal may have returned.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") void sendNow();
    });
    return () => subscription.remove();
  }, [sendNow]);

  // While anything waits, keep trying.
  const waiting = pendingCount(state);
  useEffect(() => {
    if (!loaded || waiting === 0) return;
    const timer = setInterval(() => void sendNow(), RETRY_MS);
    return () => clearInterval(timer);
  }, [loaded, waiting, sendNow]);

  const api = useMemo<TimeQueueApi>(
    () => ({
      state,
      loaded,
      sending,
      save: (row) => {
        commit((current) => enqueueItem(current, row, new Date().toISOString()));
        void sendNow();
      },
      retry: (uuid) => {
        commit((current) => retryItem(current, uuid));
        void sendNow();
      },
      discard: (uuid) => commit((current) => discardItem(current, uuid)),
      sendNow: () => void sendNow(),
    }),
    [state, loaded, sending, commit, sendNow],
  );

  return <TimeQueueContext.Provider value={api}>{children}</TimeQueueContext.Provider>;
}
