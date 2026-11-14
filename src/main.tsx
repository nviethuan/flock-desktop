import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import SettingsApp from './SettingsApp';
import TodoWidget from './components/TodoWidget';
import './assets/fonts/fonts.css';
import './styles.css';

function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // Plain browser (e.g. `npm run dev` without Tauri): behave like the first clock window.
    return 'clock-1';
  }
}

const label = currentLabel();
if (label === 'settings') {
  document.body.classList.add('window--settings');
}
if (label === 'todo') {
  document.body.classList.add('window--todo');
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element');
}

// Settings are loaded with `use()` inside the views, so each tree suspends once at startup.
createRoot(container).render(
  <StrictMode>
    <Suspense fallback={null}>
      {label === 'settings' ? <SettingsApp /> : label === 'todo' ? <TodoWidget /> : <App />}
    </Suspense>
  </StrictMode>,
);
