import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Kept in step with `DEFAULT_API_URL` in `src-tauri/src/todos.rs`. */
export const DEFAULT_TODO_API_URL = 'https://www.huannguyen.blog/api/todos';

export const TODO_CHANGED = 'todos://changed';

export type TodoScheduleMode = 'none' | 'seconds' | 'hms' | 'at';

/** The fields the API contract guarantees; the server may send more, which is ignored. */
export interface Todo {
  id: string;
  title: string;
  scheduleMode: TodoScheduleMode;
  durationSeconds: number | null;
  dueAt: string | null;
  isCompleted: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * What the panel sends. `hms` and `seconds` carry an absolute `dueAt` computed from their
 * duration, because the server does not derive it from a duration string.
 */
export interface TodoInput {
  title: string;
  scheduleMode: TodoScheduleMode;
  durationSeconds?: number | null;
  dueAt?: string | null;
}

export interface TodoWidgetSettings {
  todoId: string;
  x: number | null;
  y: number | null;
  /** `#rrggbb`, from `DIGITAL_COLORS` in `lib/colors.ts`. */
  color: string;
  neon: boolean;
  backdrop: boolean;
}

export interface TodoConfig {
  apiUrl: string;
  /** Last characters of the saved key id, for display only. */
  keyHint: string;
  hasCredentials: boolean;
  widget: TodoWidgetSettings | null;
}

export interface TodosSnapshot {
  config: TodoConfig;
  todos: Todo[];
}

export interface TodoConfigPatch {
  apiUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  clearCredentials?: boolean;
}

export interface TodoWidgetPatch {
  color?: string;
  neon?: boolean;
  backdrop?: boolean;
}

/** Errors arrive as `{ status, message }` from Rust; 0 means local/transport. */
export class TodosError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'TodosError';
    this.status = status;
  }
}

function toTodosError(error: unknown): TodosError {
  if (error instanceof TodosError) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    const status = Number((error as { status?: unknown }).status ?? 0);
    return new TodosError(message, Number.isFinite(status) ? status : 0);
  }
  if (typeof error === 'string') return new TodosError(error);
  return new TodosError('The todos request failed.');
}

const EMPTY: TodosSnapshot = {
  config: {
    apiUrl: DEFAULT_TODO_API_URL,
    keyHint: '',
    hasCredentials: false,
    widget: null,
  },
  todos: [],
};

let snapshot: TodosSnapshot = EMPTY;
let ready: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function publish(next: TodosSnapshot): TodosSnapshot {
  snapshot = next;
  notify();
  return next;
}

/** Stable snapshot for `useSyncExternalStore`; safe to read before the first fetch. */
export function getTodosSnapshot(): TodosSnapshot {
  return snapshot;
}

export function subscribeTodos(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Resolves once the event listener is attached and the Rust-side config/list cache has been
 * published. Remote errors are not part of this step: an offline API must never block the
 * panel or the widget.
 */
export function todosReady(): Promise<void> {
  ready ??= (async () => {
    try {
      await listen<TodosSnapshot>(TODO_CHANGED, (event) => {
        publish(event.payload);
      });
      publish(await invoke<TodosSnapshot>('todos_snapshot'));
    } catch {
      // A plain browser (npm run dev without Tauri) has no commands; keep the empty view.
      publish(EMPTY);
    }
  })();
  return ready;
}

async function run(
  command: string,
  args?: Record<string, unknown>,
): Promise<TodosSnapshot> {
  try {
    return publish(await invoke<TodosSnapshot>(command, args));
  } catch (error) {
    throw toTodosError(error);
  }
}

/** Saves the API URL and/or a new key+secret pair; the secret is stored in the OS keychain. */
export async function saveTodoConfig(patch: TodoConfigPatch): Promise<TodosSnapshot> {
  return run('todos_set_config', { patch });
}

/** Fetches the list. Throws `TodosError` with the API's status and a readable message. */
export async function refreshTodos(): Promise<TodosSnapshot> {
  return run('todos_refresh');
}

export async function createTodo(input: TodoInput): Promise<TodosSnapshot> {
  return run('todos_create', { input });
}

export async function updateTodo(id: string, input: TodoInput): Promise<TodosSnapshot> {
  return run('todos_update', { id, input });
}

/** Completion has its own minimal PATCH shape in the API. */
export async function setTodoCompleted(
  id: string,
  isCompleted: boolean,
): Promise<TodosSnapshot> {
  return run('todos_set_completed', { id, isCompleted });
}

export async function deleteTodo(id: string): Promise<TodosSnapshot> {
  return run('todos_delete', { id });
}

/** Creates (or re-shows) the always-on-top countdown widget for one todo. */
export async function pinTodoWidget(todoId: string): Promise<TodosSnapshot> {
  return run('todo_widget_pin', { todoId });
}

export async function unpinTodoWidget(): Promise<TodosSnapshot> {
  return run('todo_widget_unpin');
}

export async function styleTodoWidget(patch: TodoWidgetPatch): Promise<TodosSnapshot> {
  return run('todo_widget_style', { patch });
}

export function describeTodoError(error: unknown): string {
  return toTodosError(error).message;
}

/** Milliseconds left until the deadline; negative when overdue, `null` without a deadline. */
export function remainingMs(todo: Todo, now = Date.now()): number | null {
  if (!todo.dueAt) return null;
  const due = Date.parse(todo.dueAt);
  return Number.isFinite(due) ? due - now : null;
}

/** `HH:MM:SS`, or `Nd HH:MM:SS` for deadlines more than a day away. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(Math.abs(ms) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

/** 0-100 for the widget progress bar, or `null` when the todo has no duration to measure. */
export function todoProgress(todo: Todo, now = Date.now()): number | null {
  const remaining = remainingMs(todo, now);
  if (remaining === null) return null;
  const total = todo.durationSeconds;
  if (!total || total <= 0) return null;
  const progress = 1 - remaining / (total * 1000);
  return Math.min(1, Math.max(0, progress)) * 100;
}
