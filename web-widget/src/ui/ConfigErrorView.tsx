import type { ConfigLoadError } from '../config';

const TITLES: Record<ConfigLoadError['kind'], string> = {
  network: 'Configuration could not be loaded',
  http: 'Configuration could not be loaded',
  json: 'Configuration is not valid JSON',
  schema: 'Configuration is invalid',
  missing: 'Configuration not found',
};

/** Visible error state shown instead of the widget when the config is unusable. */
export function ConfigErrorView({ error }: { error: ConfigLoadError }) {
  return (
    <div class="copa-config-error" role="alert" data-kind={error.kind}>
      <strong>{TITLES[error.kind]}</strong>
      <p>{error.message}</p>
      {error.issues.length > 0 && (
        <ul>
          {error.issues.map((i, n) => (
            <li key={n}><code>{i.path || '(root)'}</code> — {i.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
