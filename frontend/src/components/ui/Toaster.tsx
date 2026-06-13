import type React from 'react';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import { useUiStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';

/**
 * Toast renderer — reads `useUiStore().toasts` and presents each as a
 * floating chrome card in the bottom-right corner. Auto-dismiss is wired
 * into `addToast` (5s) so this component is purely presentational.
 *
 * Design ref: `primitives.jsx:147–161` (`ToastStack`) +
 * `design-system.css:897–938` (`.toast-stack`, `.toast`, `.toast--success/info`).
 *
 * Variants:
 *   - default: neutral chrome
 *   - success: green icon ring (✓)
 *   - error:   red icon ring (×)
 *   - warning: amber icon ring (!)
 *
 * We render with the design's `.toast-stack` / `.toast` classes for layout
 * + animation (`@keyframes toast-in`), then layer per-variant icon styles
 * on top.
 */
export function Toaster(): React.ReactElement | null {
  const toasts = useUiStore((s) => s.toasts);
  const removeToast = useUiStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <section className="toast-stack" aria-label="Notifications" aria-live="polite">
      {toasts.map((toast) => {
        const Icon =
          toast.variant === 'error'
            ? AlertCircle
            : toast.variant === 'warning'
              ? AlertTriangle
              : toast.variant === 'success'
                ? CheckCircle2
                : Info;
        return (
          <div
            key={toast.id}
            className={cn(
              'toast',
              toast.variant === 'success' && 'toast--success',
              toast.variant === 'error' && 'toast--error',
              toast.variant === 'warning' && 'toast--warning',
              toast.variant === 'default' && 'toast--info',
            )}
            role="status"
          >
            <span className="toast__icon">
              <Icon size={14} strokeWidth={2.4} aria-hidden="true" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="toast__title">{toast.title}</div>
              {toast.description && (
                <div className="toast__body">{toast.description}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              aria-label="Dismiss"
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0 -mt-0.5 -mr-0.5"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </section>
  );
}
