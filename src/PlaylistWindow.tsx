import { useEffect, useState, type JSX } from 'react';

import { App } from './App';
import type { PlaylistWindowContext } from './shared/dj-library';

export const PlaylistWindow = (): JSX.Element => {
  const [state, setState] = useState<
    | Readonly<{ kind: 'loading' | 'error' }>
    | Readonly<{ kind: 'ready'; context: PlaylistWindowContext }>
  >({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    void window.djLibrary.playlistWindowContext().then(
      (context) => { if (active) setState({ kind: 'ready', context }); },
      () => { if (active) setState({ kind: 'error' }); },
    );
    return () => { active = false; };
  }, []);

  if (state.kind === 'ready') return <App playlistWindow={state.context} />;
  return (
    <main className="loading-state" id="main-content" role="status">
      <p>{state.kind === 'loading' ? 'Opening editor…' : 'Could not open this editor.'}</p>
      {state.kind === 'error' && <button className="quiet-button" type="button" onClick={() => window.close()}>Close window</button>}
    </main>
  );
};
