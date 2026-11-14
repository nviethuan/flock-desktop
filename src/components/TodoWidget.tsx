import { useEffect, useState } from 'react';
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTodos } from '../hooks/useTodos';
import { digitalTextStyle, resolveDigitalColor } from '../lib/colors';
import { beginWindowDrag } from '../lib/drag';
import { fontStack } from '../lib/fonts';
import {
  formatRemaining,
  refreshTodos,
  remainingMs,
  todoProgress,
  unpinTodoWidget,
} from '../lib/todos';
import type { Todo } from '../lib/todos';

function dueLabel(todo: Todo): string {
  if (!todo.dueAt) return 'No deadline set';
  const due = Date.parse(todo.dueAt);
  if (!Number.isFinite(due)) return 'No deadline set';
  return new Date(due).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The pinned-todo widget: a transparent, always-on-top window that shows one todo and a
 * live countdown to its deadline. It is display-only — CRUD lives in Settings — but the
 * card can be dragged and double-clicked to open the panel.
 */
export default function TodoWidget() {
  const snapshot = useTodos();
  const [now, setNow] = useState(() => Date.now());
  const widget = snapshot.config.widget;

  // The close button is chrome, not content: it shows for the first three seconds, then
  // only while the pointer is over the widget or keyboard focus is inside it.
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [windowFocused, setWindowFocused] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setControlsVisible(false), 3000);
    return () => window.clearTimeout(timer);
  }, []);

  // `focus` also means the widget window itself: clicking the card reveals the control
  // again, and it hides once the user focuses something else.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWindow()
        .onFocusChanged(({ payload }) => {
          if (!disposed) setWindowFocused(payload);
        })
        .then((unlistenFn) => {
          if (disposed) unlistenFn();
          else unlisten = unlistenFn;
        })
        .catch(() => {
          /* focus tracking is a nicety; hover and focus-within still work */
        });
    } catch {
      /* a plain browser session has no Tauri window */
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const revealControls = controlsVisible || hovered || focusWithin || windowFocused;
  const unpinClass = revealControls
    ? 'todo-widget__unpin'
    : 'todo-widget__unpin todo-widget__unpin--hidden';
  const revealProps = {
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => setHovered(false),
    onFocus: () => setFocusWithin(true),
    onBlur: (event: ReactFocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocusWithin(false);
    },
  };

  // Pull the latest list once when the widget opens; failures keep the cached list.
  useEffect(() => {
    void refreshTodos().catch(() => {
      /* offline or not configured: the cache and the Settings panel explain it */
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!widget) return null;

  const todo = snapshot.todos.find((entry) => entry.id === widget.todoId) ?? null;
  const accent = resolveDigitalColor(widget.color);

  const openSettings = (): void => {
    void invoke('show_settings').catch(() => {
      /* the tray still opens the panel if this fails */
    });
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    if (event.detail >= 2) {
      openSettings();
      return;
    }
    beginWindowDrag(event.nativeEvent);
  };

  const unpin = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    void unpinTodoWidget().catch(() => {
      /* the widget closes when Rust removes it; a failure must not trap the pointer */
    });
  };

  const cardStyle = { '--todo-accent': accent } as CSSProperties;


  if (!todo) {
    return (
      <div
        className="todo-widget"
        style={cardStyle}
        onPointerDown={beginDrag}
        onDoubleClick={openSettings}
        {...revealProps}
      >
        <div className={widget.backdrop ? 'todo-widget__card todo-widget__card--backdrop' : 'todo-widget__card'}>
          <header className="todo-widget__header">
            <span className="todo-widget__eyebrow">TODO</span>
            <button
              type="button"
              className={unpinClass}
              aria-label="Remove the todo widget"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={unpin}
            >
              ×
            </button>
          </header>
          <p className="todo-widget__title">This todo is no longer in the list</p>
          <div className="todo-widget__countdown todo-widget__countdown--empty">—</div>
          <footer className="todo-widget__footer">
            Refresh it in Settings → Todos, or unpin this widget.
          </footer>
        </div>
      </div>
    );
  }

  const remaining = remainingMs(todo, now);
  const done = todo.isCompleted;
  const overdue = !done && remaining !== null && remaining < 0;
  const progress = done ? null : todoProgress(todo, now);

  const countdown = done
    ? 'DONE'
    : remaining === null
      ? '—'
      : overdue
        ? `+${formatRemaining(remaining)}`
        : formatRemaining(remaining);

  const footer = done
    ? `Completed · ${dueLabel(todo)}`
    : overdue
      ? `Was due ${dueLabel(todo)}`
      : dueLabel(todo);

  return (
    <div
      className="todo-widget"
      style={cardStyle}
      onPointerDown={beginDrag}
      onDoubleClick={openSettings}
      {...revealProps}
    >
      <div className={widget.backdrop ? 'todo-widget__card todo-widget__card--backdrop' : 'todo-widget__card'}>
        <header className="todo-widget__header">
          <span className="todo-widget__eyebrow">TODO</span>
          {done ? (
            <span className="todo-widget__badge todo-widget__badge--done">Completed</span>
          ) : overdue ? (
            <span className="todo-widget__badge todo-widget__badge--late">Overdue</span>
          ) : null}
          <button
            type="button"
            className={unpinClass}
            aria-label="Remove the todo widget"
            title="Remove the todo widget"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={unpin}
          >
            ×
          </button>
        </header>

        <p
          className={done ? 'todo-widget__title todo-widget__title--done' : 'todo-widget__title'}
          title={todo.title}
        >
          {todo.title}
        </p>

        <div
          className={
            done
              ? 'todo-widget__countdown todo-widget__countdown--done'
              : overdue
                ? 'todo-widget__countdown todo-widget__countdown--late'
                : 'todo-widget__countdown'
          }
          style={{
            fontFamily: fontStack('jetbrains-mono'),
            ...(done || overdue ? {} : digitalTextStyle(widget.color, widget.neon)),
          }}
        >
          {countdown}
        </div>

        {progress !== null ? (
          <div className="todo-widget__progress" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>
        ) : null}

        <footer className="todo-widget__footer">{footer}</footer>
      </div>
    </div>
  );
}
