import type { Theme } from '../types';

interface Props {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: '☀' },
  { value: 'auto', label: '⬤' },
  { value: 'dark', label: '☾' },
];

export function ThemeToggle({ theme, setTheme }: Props) {
  return (
    <div class="theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          class={theme === value ? 'active' : ''}
          onClick={() => setTheme(value)}
          title={value}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
