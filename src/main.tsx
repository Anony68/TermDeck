import ReactDOM from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';
import './theme/tokens.css';
import App from './App';

// Note: no React.StrictMode — its double-invoked effects would spawn/kill/respawn
// real PTY processes on every mount in dev.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />);
