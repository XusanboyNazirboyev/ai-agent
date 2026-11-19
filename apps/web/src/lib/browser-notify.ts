export type NotificationState =
  'granted' | 'denied' | 'default' | 'unsupported';

/** The browser's notification permission, or 'unsupported' (also on the server). */
export function notificationState(): NotificationState {
  return typeof Notification === 'undefined'
    ? 'unsupported'
    : Notification.permission;
}

/**
 * A system notification for a due task, only when permission was granted and
 * the tab is hidden or not focused (the toast covers the visible tab).
 * Clicking it focuses the window and runs `onClick`. Never throws.
 */
export function showTaskNotification(options: {
  title: string;
  body: string;
  onClick: () => void;
}): void {
  try {
    if (notificationState() !== 'granted') return;
    const visible =
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      (typeof document.hasFocus !== 'function' || document.hasFocus());
    if (visible) return;
    const notification = new Notification(options.title, {
      body: options.body,
      tag: 'task-due',
    });
    notification.onclick = (): void => {
      try {
        window.focus();
        notification.close();
      } catch {
        // Focus can be refused; navigation still works.
      }
      options.onClick();
    };
  } catch {
    // Some browsers refuse `new Notification` (for example some mobile ones).
  }
}
