import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureError } from './analytics';

interface State {
  message: string | null;
}

/**
 * Catches render-time faults anywhere in the panel, reports them with their
 * component stack through the analytics chokepoint, and shows a recoverable
 * banner instead of React's blank screen.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureError(error, {
      source: 'error_boundary',
      handled: true,
      component_stack: info.componentStack ?? undefined,
    });
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    // .shell carries no top padding of its own - the topbar normally provides
    // it, and this fallback replaces the topbar.
    return (
      <div className="shell" style={{ paddingTop: 24 }}>
        <div className="error-banner">The admin panel hit an unexpected error: {this.state.message}</div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => location.reload()}>
            Reload the panel
          </button>
        </div>
      </div>
    );
  }
}
