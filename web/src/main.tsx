import { render } from 'preact';
import { App } from './app';
import './styles/global.css';

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
