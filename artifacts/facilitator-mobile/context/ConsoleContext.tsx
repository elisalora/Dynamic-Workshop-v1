import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TableStatus = 'flowing' | 'circling' | 'quiet' | 'converging';
export type CandidateState = 'pending' | 'ready' | 'revealed' | 'dismissed';
export type Confidence = 'low' | 'medium' | 'high';

export interface Cluster {
  id: string;
  label: string;
  emphasized: boolean;
}
export interface Idea {
  id: string;
  clusterId: string;
  text: string;
}
export interface Quote {
  id: string;
  text: string;
  timestamp: number;
}
export interface Flag {
  id: string;
  kind: string;
  text: string;
}
export interface BoardState {
  clusters: Cluster[];
  ideas: Idea[];
  links: unknown[];
  quotes: Quote[];
  flags: Flag[];
  synthesis: string | null;
}
export interface TableMetrics {
  wpmHistory: number[];
  currentWpm: number;
  novelty: number;
  status: TableStatus;
  lastSpeechAt: number;
}
export interface TableData {
  id: string;
  topic: string;
  name: string;
  questions: string[];
  summary: string;
  metrics: TableMetrics;
  board: BoardState;
  workshopId: string | null;
}
export interface WaitingSession {
  tableId: string;
  name: string;
  questions: string[];
  createdAt: number;
}
export interface ThemeCandidate {
  id: string;
  topic: string;
  rationale: string;
  confidence: Confidence;
  evidence: { table: string; quote: string }[];
  seedPrompts: string[];
  state: CandidateState;
}
export interface Workshop {
  id: string;
  name: string;
  tableIds: string[];
  createdAt: number;
  summary: string | null;
  summaryGeneratedAt: number | null;
}
export interface ArchivedTable {
  id: string;
  topic: string;
  name: string;
  summary: string;
  board: BoardState;
}

interface ConsoleState {
  tables: TableData[];
  waitingSessions: WaitingSession[];
  candidates: ThemeCandidate[];
  workshops: Workshop[];
  archivedTables: ArchivedTable[];
}

const EMPTY_STATE: ConsoleState = {
  tables: [],
  waitingSessions: [],
  candidates: [],
  workshops: [],
  archivedTables: [],
};

interface ConsoleContextType {
  state: ConsoleState;
  isConnected: boolean;
  createSession: (name: string, questions: string[]) => Promise<void>;
  createWorkshop: (name: string) => Promise<Workshop>;
  renameWorkshop: (wsId: string, name: string) => Promise<void>;
  deleteWorkshop: (wsId: string) => Promise<void>;
  generateSummary: (wsId: string) => Promise<string>;
  assignTable: (wsId: string, tableId: string) => Promise<void>;
  unassignTable: (wsId: string, tableId: string) => Promise<void>;
  archiveTable: (tableId: string) => Promise<void>;
  unarchiveTable: (tableId: string) => Promise<void>;
  deleteTable: (tableId: string) => Promise<void>;
  sendReveal: (candidateId: string) => void;
  sendRevealCustom: (candidateId: string, text: string) => void;
  sendDismiss: (candidateId: string) => void;
}

const ConsoleContext = createContext<ConsoleContextType | null>(null);

// ── Helpers ────────────────────────────────────────────────────────────────────

function getApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}/api`;
  return '/api';
}

function getWsUrl(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `wss://${domain}/api/ws?role=console`;
  return 'ws://localhost/api/ws?role=console';
}

async function apiFetch(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'POST',
  body?: unknown,
): Promise<Response> {
  const base = getApiBase();
  return fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Provider ───────────────────────────────────────────────────────────────────

export function ConsoleProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConsoleState>(EMPTY_STATE);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    const url = getWsUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setIsConnected(true);
      retryDelayRef.current = 1000;
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(evt.data as string);
        if (msg.type === 'state') {
          setState({
            tables: msg.tables ?? [],
            waitingSessions: msg.waitingSessions ?? [],
            candidates: msg.candidates ?? [],
            workshops: msg.workshops ?? [],
            archivedTables: msg.archivedTables ?? [],
          });
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setIsConnected(false);
      // Exponential backoff
      retryRef.current = setTimeout(() => {
        retryDelayRef.current = Math.min(retryDelayRef.current * 1.5, 15000);
        connect();
      }, retryDelayRef.current);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // ── WS send helpers ──────────────────────────────────────────────────────────

  const wsSend = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const sendReveal = useCallback(
    (candidateId: string) => wsSend({ type: 'reveal', candidateId }),
    [wsSend],
  );

  const sendRevealCustom = useCallback(
    (candidateId: string, text: string) =>
      wsSend({ type: 'reveal_custom', candidateId, text }),
    [wsSend],
  );

  const sendDismiss = useCallback(
    (candidateId: string) => wsSend({ type: 'dismiss', candidateId }),
    [wsSend],
  );

  // ── REST API methods ─────────────────────────────────────────────────────────

  const createSession = useCallback(
    async (name: string, questions: string[]) => {
      const res = await apiFetch('/sessions', 'POST', { name, questions });
      if (!res.ok) throw new Error(await res.text());
    },
    [],
  );

  const createWorkshop = useCallback(async (name: string): Promise<Workshop> => {
    const res = await apiFetch('/workshops', 'POST', { name });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  const renameWorkshop = useCallback(
    async (wsId: string, name: string) => {
      const res = await apiFetch(`/workshops/${wsId}`, 'PATCH', { name });
      if (!res.ok) throw new Error(await res.text());
    },
    [],
  );

  const deleteWorkshop = useCallback(async (wsId: string) => {
    const res = await apiFetch(`/workshops/${wsId}`, 'DELETE');
    if (!res.ok) throw new Error(await res.text());
  }, []);

  const generateSummary = useCallback(async (wsId: string): Promise<string> => {
    const res = await apiFetch(`/workshops/${wsId}/summary`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return data.summary as string;
  }, []);

  const assignTable = useCallback(
    async (wsId: string, tableId: string) => {
      const res = await apiFetch(`/workshops/${wsId}/assign/${tableId}`);
      if (!res.ok) throw new Error(await res.text());
    },
    [],
  );

  const unassignTable = useCallback(
    async (wsId: string, tableId: string) => {
      const res = await apiFetch(`/workshops/${wsId}/unassign/${tableId}`);
      if (!res.ok) throw new Error(await res.text());
    },
    [],
  );

  const archiveTable = useCallback(async (tableId: string) => {
    const res = await apiFetch(`/tables/${tableId}/archive`);
    if (!res.ok) throw new Error(await res.text());
  }, []);

  const unarchiveTable = useCallback(async (tableId: string) => {
    const res = await apiFetch(`/tables/${tableId}/unarchive`);
    if (!res.ok) throw new Error(await res.text());
  }, []);

  const deleteTable = useCallback(async (tableId: string) => {
    const res = await apiFetch(`/tables/${tableId}`, 'DELETE');
    if (!res.ok) throw new Error(await res.text());
  }, []);

  return (
    <ConsoleContext.Provider
      value={{
        state,
        isConnected,
        createSession,
        createWorkshop,
        renameWorkshop,
        deleteWorkshop,
        generateSummary,
        assignTable,
        unassignTable,
        archiveTable,
        unarchiveTable,
        deleteTable,
        sendReveal,
        sendRevealCustom,
        sendDismiss,
      }}
    >
      {children}
    </ConsoleContext.Provider>
  );
}

export function useConsole(): ConsoleContextType {
  const ctx = useContext(ConsoleContext);
  if (!ctx) throw new Error('useConsole must be used inside ConsoleProvider');
  return ctx;
}
