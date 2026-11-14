import { useEffect, useState } from 'react';
import { useTodos } from '../hooks/useTodos';
import { DIGITAL_COLORS, digitalColorLabel } from '../lib/colors';
import {
  createTodo,
  deleteTodo,
  describeTodoError,
  pinTodoWidget,
  refreshTodos,
  saveTodoConfig,
  setTodoCompleted,
  styleTodoWidget,
  unpinTodoWidget,
  updateTodo,
} from '../lib/todos';
import type { Todo, TodoInput, TodosSnapshot } from '../lib/todos';

/** `YYYY-MM-DDTHH:mm` in the user's zone, which is what `datetime-local` expects. */
function localDateTimeInput(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function splitDuration(totalSeconds: number): { hours: number; minutes: number; seconds: number } {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return {
    hours: Math.floor(safe / 3600),
    minutes: Math.floor((safe % 3600) / 60),
    seconds: safe % 60,
  };
}

function dueText(todo: Todo): string {
  if (!todo.dueAt) return 'No deadline';
  const due = Date.parse(todo.dueAt);
  if (!Number.isFinite(due)) return 'No deadline';
  const text = new Date(due).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return due <= Date.now() ? `Overdue · ${text}` : `Due ${text}`;
}

function scheduleText(todo: Todo): string {
  if (todo.isCompleted) return 'Done';
  if (todo.scheduleMode === 'none') return 'No schedule';
  const duration = todo.durationSeconds
    ? ` · ${new Intl.NumberFormat().format(todo.durationSeconds)}s`
    : '';
  return `${dueText(todo)}${duration}`;
}

interface TodoFormProps {
  initial?: Todo;
  submitLabel: string;
  busy: boolean;
  onSubmit: (input: TodoInput) => Promise<void> | void;
  onCancel: () => void;
}

function TodoForm({ initial, submitLabel, busy, onSubmit, onCancel }: TodoFormProps) {
  const initialDuration = initial?.durationSeconds
    ? splitDuration(initial.durationSeconds)
    : { hours: 0, minutes: 30, seconds: 0 };
  const [title, setTitle] = useState(initial?.title ?? '');
  const [mode, setMode] = useState<'none' | 'duration' | 'until'>(
    initial?.scheduleMode === 'at' ? 'until' : initial?.scheduleMode === 'none' ? 'none' : initial ? 'duration' : 'none',
  );
  const [hours, setHours] = useState(initialDuration.hours);
  const [minutes, setMinutes] = useState(initialDuration.minutes);
  const [seconds, setSeconds] = useState(initialDuration.seconds);
  const [target, setTarget] = useState(
    initial?.dueAt && Number.isFinite(Date.parse(initial.dueAt))
      ? localDateTimeInput(Date.parse(initial.dueAt))
      : '',
  );
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (): void => {
    const trimmed = title.trim();
    if (!trimmed) {
      setProblem('A todo needs a title.');
      return;
    }
    if (trimmed.length > 300) {
      setProblem('The title is limited to 300 characters.');
      return;
    }

    if (mode === 'none') {
      setProblem(null);
      void onSubmit({ title: trimmed, scheduleMode: 'none' });
      return;
    }

    if (mode === 'duration') {
      const total = hours * 3600 + minutes * 60 + seconds;
      if (total <= 0) {
        setProblem('Set a duration greater than zero.');
        return;
      }
      const dueAt = new Date(Date.now() + total * 1000);
      setProblem(null);
      void onSubmit({
        title: trimmed,
        scheduleMode: 'hms',
        durationSeconds: total,
        dueAt: dueAt.toISOString(),
      });
      return;
    }

    const timestamp = Date.parse(target);
    if (!Number.isFinite(timestamp)) {
      setProblem('Pick a date and time.');
      return;
    }
    if (timestamp <= Date.now()) {
      setProblem('Pick a moment in the future.');
      return;
    }
    setProblem(null);
    void onSubmit({
      title: trimmed,
      scheduleMode: 'at',
      durationSeconds: null,
      dueAt: new Date(timestamp).toISOString(),
    });
  };

  return (
    <div className="todos__form">
      <label className="todos__field">
        Title
        <input
          className="settings__input"
          value={title}
          maxLength={300}
          autoComplete="off"
          placeholder="What needs to happen?"
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      <label className="todos__field">
        When
        <select
          className="settings__input settings__select"
          value={mode}
          onChange={(event) => setMode(event.target.value as 'none' | 'duration' | 'until')}
        >
          <option value="none">No deadline</option>
          <option value="duration">Count down a duration</option>
          <option value="until">Until a date and time</option>
        </select>
      </label>

      {mode === 'duration' ? (
        <div className="todos__duration">
          <input
            className="settings__input"
            type="number"
            min={0}
            max={999}
            value={hours}
            aria-label="Hours"
            onChange={(event) => setHours(Math.max(0, Math.min(999, Number(event.target.value) || 0)))}
          />
          <span>h</span>
          <input
            className="settings__input"
            type="number"
            min={0}
            max={59}
            value={minutes}
            aria-label="Minutes"
            onChange={(event) => setMinutes(Math.max(0, Math.min(59, Number(event.target.value) || 0)))}
          />
          <span>m</span>
          <input
            className="settings__input"
            type="number"
            min={0}
            max={59}
            value={seconds}
            aria-label="Seconds"
            onChange={(event) => setSeconds(Math.max(0, Math.min(59, Number(event.target.value) || 0)))}
          />
          <span>s</span>
        </div>
      ) : null}

      {mode === 'until' ? (
        <label className="todos__field">
          Deadline (local time)
          <input
            className="settings__input todos__target"
            type="datetime-local"
            min={localDateTimeInput(Date.now())}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
      ) : null}

      {problem ? <p className="settings__warning">{problem}</p> : null}

      <div className="todos__formActions">
        <button type="button" onClick={submit} disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Settings → Todos: the connection, the full CRUD list, and the choice of which todo the
 * desktop countdown widget shows. Todo state is remote, so every failure is reported here
 * and never touches the clock settings.
 */
export default function TodosSection() {
  const snapshot = useTodos();
  const { config, todos } = snapshot;

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // JS dialogs are not guaranteed in a Tauri webview, so delete asks inline.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const [apiUrl, setApiUrl] = useState(config.apiUrl);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');

  const [refreshKey, setRefreshKey] = useState(0);

  // The saved URL arrives with the first snapshot, and changes after a save elsewhere.
  useEffect(() => {
    setApiUrl(config.apiUrl);
  }, [config.apiUrl]);

  // The first snapshot arrives asynchronously; only a configured connection may fetch.
  // A failed fetch is a panel error, never a reason to touch the clocks.
  useEffect(() => {
    if (!config.hasCredentials) return;
    let alive = true;
    setLoading(true);
    refreshTodos()
      .then(() => {
        if (alive) setError(null);
      })
      .catch((fetchError: unknown) => {
        if (alive) setError(describeTodoError(fetchError));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [config.hasCredentials, refreshKey]);

  const mutate = async (action: () => Promise<TodosSnapshot>, success?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
      return true;
    } catch (actionError) {
      setError(describeTodoError(actionError));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const refresh = (): void => setRefreshKey((key) => key + 1);

  const saveConnection = async (): Promise<void> => {
    const wasConfigured = config.hasCredentials;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveTodoConfig({
        apiUrl,
        apiKey: apiKey.trim() ? apiKey.trim() : undefined,
        apiSecret: apiSecret.trim() ? apiSecret.trim() : undefined,
      });
      setApiKey('');
      setApiSecret('');
      setNotice('Connection saved. The API key and secret are in the OS credential store.');
      if (wasConfigured) await refreshTodos();
    } catch (saveError) {
      setError(describeTodoError(saveError));
    } finally {
      setBusy(false);
    }
  };

  const forgetConnection = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveTodoConfig({ clearCredentials: true });
      setNotice('The saved credentials were removed from the OS credential store.');
    } catch (forgetError) {
      setError(describeTodoError(forgetError));
    } finally {
      setBusy(false);
    }
  };

  const removeTodo = async (todo: Todo): Promise<void> => {
    setConfirmingDelete(null);
    await mutate(() => deleteTodo(todo.id), 'Todo deleted.');
  };

  const pinnedTodo = config.widget
    ? (todos.find((todo) => todo.id === config.widget?.todoId) ?? null)
    : null;

  const connection = (
    <div className="todos__connectionFields">
      <label className="todos__field">
        API URL
        <input
          className="settings__input"
          value={apiUrl}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setApiUrl(event.target.value)}
        />
      </label>
      <label className="todos__field">
        API key
        <input
          className="settings__input"
          value={apiKey}
          spellCheck={false}
          autoComplete="off"
          placeholder={config.hasCredentials ? 'Saved — leave empty to keep it' : 'x-api-key'}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <label className="todos__field">
        API secret
        <input
          className="settings__input"
          type="password"
          autoComplete="new-password"
          placeholder={config.hasCredentials ? 'Saved — leave empty to keep it' : 'x-api-secret'}
          onChange={(event) => setApiSecret(event.target.value)}
        />
      </label>
      <div className="todos__row">
        <button type="button" onClick={() => void saveConnection()} disabled={busy}>
          Save connection
        </button>
        {config.hasCredentials ? (
          <button type="button" onClick={() => void forgetConnection()} disabled={busy}>
            Forget credentials
          </button>
        ) : null}
      </div>
      <p className="settings__hint">
        The key and secret go to the OS credential store (macOS Keychain, Windows Credential
        Manager, Linux Secret Service), never to settings.json or the webview. The API URL and
        the pinned widget live in their own todos.json. The key and secret must be saved
        together; saving a new pair clears the previous list.
      </p>
    </div>
  );

  return (
    <section className="settings__section">
      <h2>Todos</h2>

      {config.hasCredentials ? (
        <details className="todos__connection">
          <summary>
            Connected · key {config.keyHint || 'saved'} <span className="todos__change">Change</span>
          </summary>
          {connection}
        </details>
      ) : (
        <>
          <p className="settings__hint">
            Connect the Voca Admin todos API to show your personal todos here and on the desktop.
          </p>
          {connection}
        </>
      )}

      {error ? (
        <p className="settings__warning todos__message" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="settings__hint todos__message" role="status">
          {notice}
        </p>
      ) : null}

      {config.hasCredentials ? (
        <>
          <div className="todos__bar">
            <span className="todos__count">
              {loading
                ? 'Refreshing…'
                : `${todos.length} ${todos.length === 1 ? 'todo' : 'todos'}${todos.some((todo) => todo.isCompleted) ? ` · ${todos.filter((todo) => todo.isCompleted).length} done` : ''}`}
            </span>
            <span className="todos__barActions">
              <button type="button" onClick={refresh} disabled={busy || loading}>
                Refresh
              </button>
              <button
                type="button"
                onClick={() => setCreating((value) => !value)}
                disabled={busy}
              >
                {creating ? 'Close' : 'New todo'}
              </button>
            </span>
          </div>

          {loading ? (
            <div className="todos__loading" aria-label="Loading todos">
              <span />
            </div>
          ) : null}

          {creating ? (
            <TodoForm
              key="new"
              submitLabel="Add todo"
              busy={busy}
              onCancel={() => setCreating(false)}
              onSubmit={async (input) => {
                const ok = await mutate(() => createTodo(input), 'Todo added.');
                if (ok) setCreating(false);
              }}
            />
          ) : null}

          {todos.length === 0 && !loading && !error ? (
            <p className="settings__hint">No todos yet. Add one, or refresh after creating it elsewhere.</p>
          ) : null}

          <ul className="todos__list">
            {todos.map((todo) => {
              const pinned = config.widget?.todoId === todo.id;
              return (
                <li
                  className={todo.isCompleted ? 'todos__item todos__item--done' : 'todos__item'}
                  key={todo.id}
                >
                  <label className="todos__check">
                    <input
                      type="checkbox"
                      checked={todo.isCompleted}
                      disabled={busy}
                      aria-label={`Mark “${todo.title}” as ${todo.isCompleted ? 'not done' : 'done'}`}
                      onChange={(event) => {
                        const completed = event.target.checked;
                        void mutate(
                          () => setTodoCompleted(todo.id, completed),
                          completed ? 'Todo completed.' : 'Todo reopened.',
                        );
                      }}
                    />
                    <span className="todos__title">{todo.title}</span>
                  </label>
                  <span className="todos__schedule">{scheduleText(todo)}</span>
                  <div className="todos__actions">
                    <button
                      type="button"
                      onClick={() => setEditingId(editingId === todo.id ? null : todo.id)}
                      disabled={busy}
                    >
                      {editingId === todo.id ? 'Close' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        pinned
                          ? void mutate(() => unpinTodoWidget(), 'Widget removed.')
                          : void mutate(() => pinTodoWidget(todo.id), 'Widget pinned to the desktop.')
                      }
                      disabled={busy}
                    >
                      {pinned ? 'Unpin widget' : 'Pin widget'}
                    </button>
                    {confirmingDelete === todo.id ? (
                      <>
                        <button
                          type="button"
                          className="todos__delete"
                          onClick={() => void removeTodo(todo)}
                          disabled={busy}
                        >
                          Confirm delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(null)}
                          disabled={busy}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="todos__delete"
                        onClick={() => setConfirmingDelete(todo.id)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                  {editingId === todo.id ? (
                    <TodoForm
                      key={todo.id}
                      initial={todo}
                      submitLabel="Save changes"
                      busy={busy}
                      onCancel={() => setEditingId(null)}
                      onSubmit={async (input) => {
                        const ok = await mutate(() => updateTodo(todo.id, input), 'Todo updated.');
                        if (ok) setEditingId(null);
                      }}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>

          {config.widget ? (
            <div className="todos__widget">
              <p className="todos__widgetHead">
                Countdown widget
                <span>{pinnedTodo ? pinnedTodo.title : 'The pinned todo is no longer in the list'}</span>
              </p>
              <div className="swatches" role="group" aria-label="Widget colour">
                {DIGITAL_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    className="swatches__option"
                    style={{ background: color.value }}
                    aria-pressed={config.widget?.color === color.value}
                    aria-label={color.label}
                    title={color.label}
                    onClick={() => void mutate(() => styleTodoWidget({ color: color.value }))}
                  />
                ))}
              </div>
              <p className="settings__hint">
                {digitalColorLabel(config.widget.color)}. The widget counts down to the todo's
                deadline and shows a progress bar for its duration.
              </p>
              <div className="settings__toggles">
                <label className="settings__toggle">
                  <input
                    type="checkbox"
                    checked={config.widget.neon}
                    onChange={(event) =>
                      void mutate(() => styleTodoWidget({ neon: event.target.checked }))
                    }
                  />
                  Neon glow
                </label>
                <label className="settings__toggle">
                  <input
                    type="checkbox"
                    checked={config.widget.backdrop}
                    onChange={(event) =>
                      void mutate(() => styleTodoWidget({ backdrop: event.target.checked }))
                    }
                  />
                  Dark backdrop
                </label>
              </div>
              <button
                type="button"
                className="todos__unpin"
                onClick={() => void mutate(() => unpinTodoWidget(), 'Widget removed.')}
                disabled={busy}
              >
                Remove the desktop widget
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
