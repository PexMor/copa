import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CopaAuthError, type AuthContext, type AuthState, type InteractiveProvider, type PairingCapable, type TokenSources } from '../auth';
import type { EndpointConfig, WidgetConfig } from '../config';
import { ApiError, type HistoryEvent, type HistoryItem } from '../core';
import { LiveEvents, type LiveState } from '../live';
import { CopaSession, type ShareData, type ShareOptions } from '../session';
import { ConfigErrorView } from './ConfigErrorView';
import { FilePanel, type UploadRow } from './FilePanel';
import { HistoryPanel } from './HistoryPanel';
import { PairingPanel } from './PairingPanel';
import { TextPanel } from './TextPanel';
import { useAuthState, useLoadedConfig, type ConfigProps } from './hooks';
import { safeStorage } from './storage';
import { CSS } from './styles';

/** Imperative API handed to the host application through `onReady`. */
export interface CopaHandle {
  /** Share text, a File or a Blob; resolves with the stored item. Rejects with CopaAuthError when signed out. */
  share(data: ShareData, opts?: ShareOptions): Promise<HistoryItem>;
  /** The namespace's current clipboard text. */
  paste(): Promise<string>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

/** Operations of the endpoint view that is currently shown. */
interface Ops {
  share: CopaHandle['share'];
  paste: CopaHandle['paste'];
  signIn: CopaHandle['signIn'];
  signOut: CopaHandle['signOut'];
}

export interface CopaShareProps extends ConfigProps {
  /** Endpoint to show first; otherwise the remembered one, `defaultEndpoint`, or the first. */
  endpointId?: string;
  /** Token providers for `tokenFrom` endpoints. */
  tokenSources?: TokenSources;
  /** Advanced: browser access for the sign-in code (tests, unusual hosts). */
  authContext?: Omit<AuthContext, 'tokenSources'>;
  theme?: 'light' | 'auto' | 'dark';
  onItem?: (item: HistoryItem) => void;
  onAuthChange?: (state: AuthState, endpointId: string) => void;
  onError?: (error: unknown) => void;
  /** Receives the host API once; calls made before an endpoint is connected reject with CopaAuthError. */
  onReady?: (handle: CopaHandle) => void;
}

const ENDPOINT_KEY = 'copa-widget:endpoint';

/** What went wrong when the server answered the first request, in words a user can act on. */
export function describeAccessError(e: unknown, method: string): string {
  if (e instanceof ApiError && e.status === 401) {
    return method === 'static-token'
      ? 'The server did not accept the token.'
      : 'The server did not accept your sign-in. It may be meant for another server, come from an issuer this server does not trust, or have expired. Sign out and try again; if it persists, ask the operator.';
  }
  if (e instanceof ApiError && e.status === 403) {
    return 'You are signed in, but your account has no access to this namespace.';
  }
  return e instanceof Error ? e.message : String(e);
}

function pickEndpoint(config: WidgetConfig, wanted?: string): EndpointConfig {
  const byId = (id: string | null | undefined) => config.endpoints.find((e) => e.id === id);
  return byId(wanted) ?? byId(safeStorage.get(ENDPOINT_KEY)) ?? byId(config.defaultEndpoint) ?? config.endpoints[0];
}

/** The widget: loads the configuration, then shows the selected endpoint. */
export function CopaShare(props: CopaShareProps) {
  const load = useLoadedConfig(props);
  const onError = props.onError;
  const ops = useRef<Ops | null>(null);
  const disconnected = () => Promise.reject(new CopaAuthError('not-authenticated', 'The widget is not connected to an endpoint'));
  const handle = useMemo<CopaHandle>(() => ({
    share: (d, o) => (ops.current ? ops.current.share(d, o) : disconnected()),
    paste: () => (ops.current ? ops.current.paste() : disconnected()),
    signIn: () => (ops.current ? ops.current.signIn() : disconnected()),
    signOut: () => (ops.current ? ops.current.signOut() : disconnected()),
  }), []);
  useEffect(() => { props.onReady?.(handle); }, [handle]);
  useEffect(() => {
    if (load.status === 'error') onError?.(load.error);
  }, [load.status === 'error' ? load.error : null]);

  const theme = props.theme ?? (load.status === 'ready' ? load.config.ui?.theme : undefined) ?? 'auto';
  return (
    <div class="copa-share" data-theme={theme}>
      <style>{CSS}</style>
      {load.status === 'loading' && <div class="copa-muted" role="status">Loading…</div>}
      {load.status === 'error' && <ConfigErrorView error={load.error} />}
      {load.status === 'ready' && <ConfiguredShare {...props} config={load.config} ops={ops} />}
    </div>
  );
}

function ConfiguredShare(props: CopaShareProps & { config: WidgetConfig; ops: { current: Ops | null } }) {
  const { config } = props;
  const [endpointId, setEndpointId] = useState(() => pickEndpoint(config, props.endpointId).id);
  const endpoint = config.endpoints.find((e) => e.id === endpointId) ?? config.endpoints[0];

  const choose = (id: string) => {
    setEndpointId(id);
    safeStorage.set(ENDPOINT_KEY, id);
  };

  return (
    <>
      {config.endpoints.length > 1 && (
        <div class="copa-row">
          <label class="copa-muted" for="copa-endpoint">Server</label>
          <select id="copa-endpoint" value={endpoint.id} onChange={(e) => choose((e.currentTarget as HTMLSelectElement).value)}>
            {config.endpoints.map((e) => <option key={e.id} value={e.id}>{e.id}</option>)}
          </select>
        </div>
      )}
      <EndpointView key={endpoint.id} endpoint={endpoint} {...props} />
    </>
  );
}

function EndpointView({ endpoint, tokenSources, authContext, onItem, onAuthChange, onError, ops }: CopaShareProps & { endpoint: EndpointConfig; ops: { current: Ops | null } }) {
  const built = useMemo(() => {
    try { return { session: new CopaSession(endpoint, { ...authContext, tokenSources }) }; }
    catch (e) { return { error: e as Error }; }
  }, [endpoint]);

  useEffect(() => {
    if (built.error) onError?.(built.error);
  }, [built]);

  if (built.error || !built.session) {
    return <div class="copa-error" role="alert">{built.error?.message ?? 'Cannot connect'}</div>;
  }
  return <ConnectedView session={built.session} onItem={onItem} onAuthChange={onAuthChange} onError={onError} ops={ops} />;
}

interface ConnectedProps {
  session: CopaSession;
  onItem?: CopaShareProps['onItem'];
  onAuthChange?: CopaShareProps['onAuthChange'];
  onError?: CopaShareProps['onError'];
  ops: { current: Ops | null };
}

function ConnectedView({ session, onItem, onAuthChange, onError, ops }: ConnectedProps) {
  const auth = useAuthState(session.provider);
  const [capsReady, setCapsReady] = useState(false);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [now, setNow] = useState(Date.now());
  const [fatal, setFatal] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [signInError, setSignInError] = useState<CopaAuthError | null>(null);
  const [liveState, setLiveState] = useState<LiveState>('stopped');
  const reported = useRef(new Set<string>());
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const report = useCallback((e: unknown) => { onError?.(e); }, [onError]);

  const refresh = useCallback(async () => {
    if (!live.current) return; // unmounted: no late requests
    try {
      const list = await session.history();
      if (live.current) { setItems(list); setNow(Date.now()); }
    } catch (e) { report(e); }
  }, [session, report]);

  useEffect(() => {
    onAuthChange?.(auth, session.endpoint.id);
    if (auth === 'ready') setAuthRequired(false);
  }, [auth]);

  // capabilities and first history load once credentials are usable
  useEffect(() => {
    if (auth !== 'ready') { setCapsReady(false); return; }
    let cancelled = false;
    session.loadCapabilities().then(async () => {
      if (cancelled) return;
      setCapsReady(true);
      await refresh();
    }, (e) => {
      if (cancelled) return;
      setFatal(describeAccessError(e, session.provider.method));
      report(e);
    });
    return () => { cancelled = true; };
  }, [auth, session]);

  // Live updates while the credentials are usable and history is enabled.
  useEffect(() => {
    if (auth !== 'ready' || !capsReady || !session.historyEnabled) { setLiveState('stopped'); return; }
    const onEvent = (ev: HistoryEvent) => {
      if (ev.type === 'item_added') {
        setItems((list) => (list.some((i) => i.id === ev.item.id) ? list : [ev.item, ...list]));
        setNow(Date.now());
        emitItem(ev.item);
      } else {
        setItems((list) => list.filter((i) => i.id !== ev.id));
      }
    };
    const live = new LiveEvents(session, {
      onEvent,
      onState: setLiveState,
      onConnected: () => { void refresh(); }, // resync anything missed while offline
    });
    live.start();
    return () => live.stop();
  }, [auth, capsReady, session]);

  const patchUpload = (key: string, change: Partial<UploadRow>) =>
    setUploads((u) => u.map((r) => (r.key === key ? { ...r, ...change } : r)));

  /** `onItem` fires once per stored item, whether it arrived from our own share or from the live stream. */
  const emitItem = useCallback((item: HistoryItem) => {
    if (item.id) {
      if (reported.current.has(item.id)) return;
      reported.current.add(item.id);
    }
    onItem?.(item);
  }, [onItem]);

  /** Every share — from the UI or the host — goes through here. */
  const doShare = useCallback(async (data: ShareData, opts: ShareOptions = {}): Promise<HistoryItem> => {
    let key: string | undefined;
    try {
      const item = await session.share(data, {
        ...opts,
        onStart: ({ name, total }) => {
          key = Math.random().toString(36).slice(2);
          setUploads((u) => [...u, { key: key!, name, loaded: 0, total }]);
          opts.onStart?.({ name, total });
        },
        onProgress: (loaded) => { if (key) patchUpload(key, { loaded }); opts.onProgress?.(loaded); },
      });
      if (key) setUploads((u) => u.filter((r) => r.key !== key));
      void refresh();
      emitItem(item);
      return item;
    } catch (e) {
      if (key) patchUpload(key, { error: e instanceof Error ? e.message : String(e) });
      if (e instanceof CopaAuthError) setAuthRequired(true);
      report(e);
      throw e;
    }
  }, [session, refresh, emitItem, report]);

  const doPaste = useCallback(async () => {
    try { return await session.pull(); } catch (e) {
      if (e instanceof CopaAuthError) setAuthRequired(true);
      report(e);
      throw e;
    }
  }, [session, report]);

  const interactive = session.provider as typeof session.provider & InteractiveProvider;
  const pairing = (session.provider as Partial<PairingCapable>).beginPairing ? (session.provider as unknown as PairingCapable) : null;

  const signIn = useCallback(async () => {
    if (!session.provider.signIn) throw new CopaAuthError('unsupported-method', 'This endpoint has no interactive sign-in');
    setSignInError(null);
    try {
      await session.provider.signIn();
    } catch (e) {
      // "cancelled" is the user's own choice: say so quietly instead of raising an alarm
      if (e instanceof CopaAuthError) setSignInError(e);
      if (!(e instanceof CopaAuthError && e.code === 'cancelled')) report(e);
      throw e;
    }
  }, [session, report]);

  const signInOnThisPage = useCallback(() => {
    setSignInError(null);
    interactive.signInRedirect?.().catch((e) => {
      if (e instanceof CopaAuthError) setSignInError(e);
      report(e);
    });
  }, [interactive, report]);

  // a sign-in that finished while this page was away (redirect flow) may already have failed
  useEffect(() => {
    if (auth !== 'pending' && interactive.lastError) setSignInError(interactive.lastError);
  }, [auth, interactive]);

  // expose this endpoint to the host API
  useEffect(() => {
    ops.current = {
      share: doShare,
      paste: doPaste,
      signIn,
      signOut: () => session.provider.signOut(),
    };
    return () => { ops.current = null; };
  }, [doShare, doPaste, signIn, session]);

  const startUploads = useCallback((files: File[]) => {
    for (const file of files) doShare(file).catch(() => { /* shown on the upload row, reported via onError */ });
  }, [doShare]);

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0 || !session.filesEnabled || !session.canWrite) return;
    e.preventDefault(); // an image paste must not insert text
    startUploads(files);
  };

  return (
    <div onPaste={onPaste as unknown as (e: Event) => void}>
      <div class="copa-row">
        <span class="copa-muted" data-role="auth-state">{session.endpoint.id}: {auth}</span>
        {liveState !== 'stopped' && <span class="copa-muted" data-role="live-state" data-state={liveState}>· {liveState === 'live' ? 'live' : liveState === 'unavailable' ? 'manual refresh' : liveState}</span>}
        <span class="copa-spacer" />
        {auth === 'pending' && (
          <>
            <span class="copa-muted" data-role="waiting" role="status">Waiting for sign-in…</span>
            {interactive.cancelSignIn && (
              <button type="button" data-action="cancel-sign-in" onClick={() => interactive.cancelSignIn?.()}>Cancel</button>
            )}
          </>
        )}
        {auth !== 'ready' && auth !== 'pending' && session.provider.signIn && (
          <button type="button" class="primary" data-action="sign-in" onClick={() => { signIn().catch(() => {}); }}>
            {signInError ? 'Try again' : 'Sign in'}
          </button>
        )}
        {auth !== 'ready' && auth !== 'pending' && signInError?.code === 'popup-blocked' && interactive.signInRedirect && (
          <button type="button" data-action="sign-in-redirect" onClick={signInOnThisPage}>Sign in on this page</button>
        )}
        {auth === 'ready' && session.provider.method !== 'static-token' && (
          <button type="button" data-action="sign-out" onClick={() => { session.provider.signOut().catch(report); }}>Sign out</button>
        )}
      </div>
      {signInError && auth !== 'ready' && auth !== 'pending' && (
        <div class={signInError.code === 'cancelled' ? 'copa-muted' : 'copa-error'} role={signInError.code === 'cancelled' ? 'status' : 'alert'} data-role="sign-in-error" data-code={signInError.code}>
          {signInError.message}
        </div>
      )}
      {auth !== 'ready' && authRequired && (
        <div class="copa-error" role="alert" data-role="sign-in-required">Sign in to share</div>
      )}
      {pairing && auth !== 'ready' && <PairingPanel provider={pairing} auth={auth} onError={report} />}
      {auth !== 'ready' && !session.provider.signIn && !pairing && (
        <div class="copa-error" role="alert">
          {new CopaAuthError('not-authenticated', 'No credentials are available for this endpoint').message}
        </div>
      )}
      {fatal && <div class="copa-error" role="alert" data-role="access-error">{fatal}</div>}
      {auth === 'ready' && capsReady && (
        <>
          <TextPanel session={session} onError={report} onShare={(text) => doShare(text)} />
          {session.filesEnabled && session.canWrite && (
            <FilePanel
              session={session}
              uploads={uploads}
              onFiles={startUploads}
              onDismiss={(key) => setUploads((u) => u.filter((r) => r.key !== key))}
            />
          )}
          {session.historyEnabled && (
            <HistoryPanel
              session={session}
              items={items}
              now={now}
              onRefresh={() => { void refresh(); }}
              onDeleted={(id) => setItems((list) => list.filter((i) => i.id !== id))}
              onError={report}
            />
          )}
        </>
      )}
    </div>
  );
}
