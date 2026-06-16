import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Optionaler Reset-Schluessel — aendert er sich, wird die Boundary zurueckgesetzt. */
  resetKey?: string
}
interface State { fehler: Error | null; vorigerKey?: string }

/**
 * Faengt Render-/Lazy-Load-Fehler ab, damit ein Defekt in EINEM Bereich nicht
 * die gesamte Kasse weissscreent. Zeigt einen erholbaren Fallback (erneut
 * versuchen / neu laden) statt eines weissen Bildschirms — kritisch fuer einen
 * Kassen-Arbeitsplatz im laufenden Betrieb.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { fehler: null }

  static getDerivedStateFromError(fehler: Error): Partial<State> {
    return { fehler }
  }

  /** Reset, wenn sich der resetKey aendert (z. B. Routenwechsel). */
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.fehler && props.resetKey !== state.vorigerKey) {
      return { fehler: null, vorigerKey: props.resetKey }
    }
    if (props.resetKey !== state.vorigerKey) {
      return { vorigerKey: props.resetKey }
    }
    return null
  }

  componentDidCatch(fehler: Error, info: ErrorInfo): void {
    // Sichtbar im Browser-Log; hier koennte spaeter ein Error-Reporter haengen.
    console.error('UI-Fehler abgefangen:', fehler, info.componentStack)
  }

  private reset = () => this.setState({ fehler: null })

  render(): ReactNode {
    if (this.state.fehler) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="text-4xl" aria-hidden>⚠️</div>
          <h2 className="text-lg font-semibold text-gray-900">Es ist ein Fehler aufgetreten</h2>
          <p className="max-w-md text-sm text-gray-600">
            Dieser Bereich konnte nicht geladen werden. Die Kasse läuft weiter — du kannst es
            erneut versuchen oder die Seite neu laden.
          </p>
          <div className="flex gap-2 pt-1">
            <button
              onClick={this.reset}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Erneut versuchen
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-md bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
            >
              Neu laden
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
