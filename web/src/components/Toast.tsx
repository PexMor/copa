import type { ToastMessage } from '../types';

interface Props {
  messages: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function Toast({ messages, onDismiss }: Props) {
  if (messages.length === 0) return null;
  return (
    <div class="toast-container">
      {messages.map((m) => (
        <div key={m.id} class={`toast toast-${m.type || 'info'}`} onClick={() => onDismiss(m.id)}>
          {m.text}
        </div>
      ))}
    </div>
  );
}
