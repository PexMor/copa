import { render } from 'preact';
import { App } from './app';
import { AccessGate } from './components/AccessGate';
import './styles/global.css';
import { logWebVersion } from './utils/version';

logWebVersion();

render(<AccessGate><App /></AccessGate>, document.getElementById('app')!);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
