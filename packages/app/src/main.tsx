import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type Data,
  type Envelope,
  type Pack,
  type Field,
  type Page,
  type Lease,
  type Evaluation,
  type Role,
  get,
  set,
  expand,
} from '../../core/model';
import { compile, evaluate, visible } from '../../core/engine';
import './style.css';

type User = { id: string; username: string; role: Role; demo: boolean };
type Loaded = { record: Envelope; etag: string; evaluation: Evaluation; lease: any };
const labels: Record<string, string> = {
  needs_input: 'Needs input',
  cbs_ready: 'CBS ready',
  aaf_ready: 'AAF ready',
  amendment_pending: 'Amendment pending',
  on_hold: 'On hold',
};
const label = (v: string) =>
  labels[v] ?? v.replaceAll('_', ' ').replace(/^./, (s) => s.toUpperCase());
const date = (v: string) =>
  new Date(v).toLocaleString('en-AU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let message = 'Request failed';
    try {
      message = (await response.json()).message;
    } catch {}
    const error = new Error(message) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return response.json();
}
function Badge({ value }: { value: string }) {
  return (
    <span
      className={`badge ${value === 'reconciled' || value === 'cbs_ready' ? 'good' : value === 'blocked' || value === 'on_hold' ? 'bad' : ''}`}
    >
      {label(value)}
    </span>
  );
}
function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    dashboard: (
      <>
        <rect x="2" y="2" width="6" height="6" />
        <rect x="12" y="2" width="6" height="6" />
        <rect x="2" y="12" width="6" height="6" />
        <rect x="12" y="12" width="6" height="6" />
      </>
    ),
    queue: (
      <>
        <path d="M2 3h16v14H2zM2 8h16M6 11h8M6 14h5" />
      </>
    ),
    records: (
      <>
        <path d="M5 2h9l3 3v13H5zM8 8h6M8 11h6M8 14h4" />
      </>
    ),
    import: (
      <>
        <path d="M10 1v12m-4-4 4 4 4-4M3 12v6h14v-6" />
      </>
    ),
    batches: (
      <>
        <path d="M2 5h6l2 2h8v11H2zM4 2h10l3 3" />
      </>
    ),
    trace: (
      <>
        <path d="M3 2h14v16H3zM6 6h8M6 10h8M6 14h5" />
      </>
    ),
    config: (
      <>
        <path d="M2 4h16M2 10h16M2 16h16M6 2v4M14 8v4M8 14v4" />
      </>
    ),
    admin: (
      <>
        <circle cx="10" cy="6" r="4" />
        <path d="M3 18v-3a7 7 0 0 1 14 0v3" />
      </>
    ),
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      {paths[name] ?? paths.records}
    </svg>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [checking, setChecking] = useState(true),
    [connected, setConnected] = useState(true),
    [pack, setPack] = useState<Pack | null>(null),
    [overview, setOverview] = useState<any>(null),
    [view, setView] = useState('queue'),
    [status, setStatus] = useState('Ready'),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Loaded | null>(null),
    [lease, setLease] = useState<Lease | null>(null),
    [draft, setDraft] = useState<Data>({}),
    [page, setPage] = useState('entity'),
    [savedDraft, setSavedDraft] = useState<any>(null),
    [trace, setTrace] = useState<any[]>([]),
    [users, setUsers] = useState<any[]>([]);
  const [search, setSearch] = useState(''),
    [stateFilter, setStateFilter] = useState('all'),
    [tier, setTier] = useState('all'),
    [errorClass, setErrorClass] = useState('all'),
    [age, setAge] = useState('all'),
    [assignee, setAssignee] = useState('all'),
    [traceSearch, setTraceSearch] = useState('');
  const [importData, setImportData] = useState<any>(null),
    [csvImport, setCsvImport] = useState<{ files: Record<string, string>; name: string } | null>(
      null,
    ),
    [importError, setImportError] = useState(''),
    [reason, setReason] = useState(''),
    [loginError, setLoginError] = useState('');
  const leaseRef = useRef<{ id: string; token: string } | null>(null),
    lastActive = useRef(Date.now()),
    dirty = useRef(false),
    activityWarning = useRef(false),
    messageRef = useRef<HTMLDivElement>(null);
  const tell = (text: string) => {
    setStatus(text);
  };
  const fail = (error: any) => {
    tell(error.message);
    if (error.status === 401) {
      setUser(null);
      setLease(null);
      leaseRef.current = null;
    }
  };
  const refresh = useCallback(async () => {
    const data = await api('/overview');
    setOverview(data);
    if (data.notices?.length) setStatus(data.notices.map((n: any) => n.message).join(' '));
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    api('/me')
      .then(setUser)
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    Promise.all([api('/config').then(setPack), refresh()]).catch(fail);
    const events = new EventSource('/api/events');
    events.addEventListener('connected', () => setConnected(true));
    events.addEventListener('changed', () => {
      setConnected(true);
      refresh().catch(fail);
    });
    events.onerror = () => {
      setConnected(false);
      tell('Connection interrupted. Use Refresh to check the latest state.');
    };
    return () => events.close();
  }, [user?.id]);
  useEffect(() => {
    if (view === 'trace' && user)
      api('/trace' + (traceSearch ? '?recordId=' + encodeURIComponent(traceSearch) : ''))
        .then(setTrace)
        .catch(fail);
    if (view === 'admin' && user?.role === 'admin') api('/users').then(setUsers).catch(fail);
  }, [view, user?.id, traceSearch]);
  useEffect(() => {
    const activity = () => {
      lastActive.current = Date.now();
      activityWarning.current = false;
    };
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    return () => {
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
    };
  }, []);
  useEffect(() => {
    if (!selected || !user) return;
    const timer = setInterval(async () => {
      const current = leaseRef.current;
      if (!current) return;
      const idle = Date.now() - lastActive.current;
      if (idle >= pack!.operations.inactivityMs) {
        try {
          await api(`/records/${current.id}/lease/release`, 'POST', { leaseToken: current.token });
        } catch {}
        setLease(null);
        leaseRef.current = null;
        tell('Lease released after 30 minutes of inactivity. Your draft is kept in this tab.');
        return;
      }
      if (
        idle >= pack!.operations.inactivityMs - pack!.operations.renewMs &&
        !activityWarning.current
      ) {
        activityWarning.current = true;
        tell('Inactive for 25 minutes. Your lease will be released in 5 minutes.');
      }
      if (idle < pack!.operations.inactivityMs - pack!.operations.renewMs)
        try {
          const renewed = await api(`/records/${current.id}/lease/renew`, 'POST', {
            leaseToken: current.token,
          });
          setLease(renewed);
        } catch (e) {
          setLease(null);
          leaseRef.current = null;
          fail(e);
        }
    }, pack!.operations.renewMs);
    const poll = setInterval(async () => {
      try {
        const live = await api(`/records/${selected.record.recordId}`);
        if (leaseRef.current && live.lease?.holder !== user.id) {
          setLease(null);
          leaseRef.current = null;
          tell('Your lease ended. Your unsaved draft is kept in this tab.');
        }
      } catch (e) {
        fail(e);
      }
    }, 1500);
    return () => {
      clearInterval(timer);
      clearInterval(poll);
    };
  }, [selected?.record.recordId, user?.id]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const hide = () => {
      const current = leaseRef.current;
      if (current)
        fetch(`/api/records/${current.id}/lease/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leaseToken: current.token }),
          keepalive: true,
        });
    };
    window.addEventListener('beforeunload', before);
    window.addEventListener('pagehide', hide);
    return () => {
      window.removeEventListener('beforeunload', before);
      window.removeEventListener('pagehide', hide);
    };
  }, []);
  async function release() {
    const current = leaseRef.current;
    if (current)
      try {
        await api(`/records/${current.id}/lease/release`, 'POST', { leaseToken: current.token });
      } catch {}
    leaseRef.current = null;
    setLease(null);
  }
  async function closeRecord() {
    await release();
    setSelected(null);
    dirty.current = false;
    setSavedDraft(null);
    await refresh();
  }
  async function openRecord(recordId: string) {
    await release();
    const loaded: Loaded = await api(`/records/${encodeURIComponent(recordId)}`);
    setSelected(loaded);
    setDraft(structuredClone(loaded.record.pendingData ?? loaded.record.data));
    dirty.current = false;
    const saved = sessionStorage.getItem(`draft:${user!.id}:${recordId}`);
    setSavedDraft(saved ? JSON.parse(saved) : null);
    const failure = loaded.evaluation.rules.find((r) => !r.passed);
    setPage(
      pack!.schema.pages.find((p) => p.sections.some((s) => s.id === failure?.section))?.id ??
        'entity',
    );
    if (!['reconciled', 'loaded', 'exported', 'withdrawn'].includes(loaded.record.state)) {
      const acquired = await api(`/records/${recordId}/lease`, 'POST', {});
      if (acquired.leaseToken) {
        setLease(acquired);
        leaseRef.current = { id: recordId, token: acquired.leaseToken };
        tell(`Checked out ${recordId}. Edit lease acquired.`);
      } else tell(`Read only. In use by ${acquired.heldBy} since ${date(acquired.since)}.`);
    } else tell(`${recordId} is ${label(loaded.record.state).toLowerCase()}. Record is frozen.`);
  }
  function change(path: string, value: unknown) {
    const next = structuredClone(draft);
    set(next, path, value);
    setDraft(next);
    dirty.current = true;
    sessionStorage.setItem(
      `draft:${user!.id}:${selected!.record.recordId}`,
      JSON.stringify({ data: next, etag: selected!.etag, at: new Date().toISOString() }),
    );
  }
  async function save() {
    if (!selected || !lease) return;
    const result = await api(
      `/records/${selected.record.recordId}${selected.record.state === 'amendment_pending' ? '/amendment' : ''}`,
      'PUT',
      {
        data: draft,
        etag: selected.etag,
        leaseToken: lease.leaseToken,
        resolveConflicts: selected.record.conflicts.length > 0 && user!.role !== 'operator',
      },
    );
    sessionStorage.removeItem(`draft:${user!.id}:${selected.record.recordId}`);
    leaseRef.current = null;
    setLease(null);
    dirty.current = false;
    setSelected({ ...selected, ...result, evaluation: evaluate(pack!, result.record.data) });
    setSavedDraft(null);
    tell(`Saved ${selected.record.recordId}. ${label(result.record.state)}. Lease released.`);
    await refresh();
  }
  const local = pack && selected ? evaluate(pack, draft) : null;
  const isAdmin = user?.role === 'admin',
    isReviewer = isAdmin || user?.role === 'reviewer';
  const nav = [
    ['queue', 'Exception queue'],
    ['dashboard', 'Overview'],
    ['records', 'Customer records'],
    ['import', 'Import extract'],
    ['batches', 'Batch control'],
    ['trace', 'Audit trace'],
    ['config', 'Configuration'],
    ...(isAdmin ? [['admin', 'Administration']] : []),
  ];
  async function navigate(next: string) {
    if (selected) await closeRecord();
    setView(next);
    setSearch('');
    setStateFilter('all');
  }
  if (checking)
    return (
      <div className="login-desktop">
        <div className="boot-status" role="status">
          Opening MIGTOOL...
        </div>
      </div>
    );
  if (!user)
    return (
      <div className="login-desktop">
        <form
          className="login-window raised"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(async () => {
              try {
                const result = await api('/login', 'POST', {
                  username: form.get('username'),
                  password: form.get('password'),
                });
                const me = await api('/me');
                setUser(me);
                setSelected(null);
                setLoginError('');
                tell(`Signed in as ${result.username}. Ready.`);
              } catch (e) {
                setLoginError((e as Error).message);
              }
            });
          }}
        >
          <div className="titlebar">
            <span className="appmark">M</span> MIGTOOL{' '}
            <span className="title-sub">Migration control</span>
          </div>
          <div className="login-body">
            <div className="login-brand">
              BANK 1 <span>TO</span> BANK 2
            </div>
            <h1>Sign in to your workspace</h1>
            <p>Customer migration operations</p>
            <label>
              Username
              <input name="username" autoComplete="username" required autoFocus />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            {loginError && (
              <p className="error" role="alert">
                {loginError}
              </p>
            )}
            <div className="login-actions">
              <span>4-hour secure session</span>
              <button className="primary" disabled={busy}>
                {busy ? 'Signing in...' : 'Sign in'}
              </button>
            </div>
          </div>
          <div className="statusbar">
            MIGTOOL 0.1 <span>Authorised personnel only</span>
          </div>
        </form>
      </div>
    );
  if (!overview || !pack)
    return (
      <div className="login-desktop">
        <div className="boot-status" role="status">
          Loading migration workspace...
        </div>
      </div>
    );
  const d = overview.dashboard;
  const filteredRecords = overview.records.filter(
    (r: any) =>
      (r.name + ' ' + r.recordId).toLowerCase().includes(search.toLowerCase()) &&
      (stateFilter === 'all' || r.state === stateFilter),
  );
  const exceptions = overview.exceptions.filter(
    (e: any) =>
      (e.recordId + ' ' + e.message + ' ' + e.code).toLowerCase().includes(search.toLowerCase()) &&
      (tier === 'all' || e.tier === Number(tier)) &&
      (errorClass === 'all' || e.errorClass === errorClass) &&
      (assignee === 'all' || e.assignee === (assignee === 'mine' ? user.username : '')) &&
      (age === 'all' ||
        Date.now() - Date.parse(e.createdAt) > (age === '24' ? 86400000 : 172800000)),
  );
  async function batchAction(batch: any, action: string) {
    if (action === 'release') {
      const result = await api(`/batches/${batch.id}/release`, 'POST', {});
      tell(
        `${result.queued} records queued for CBS delivery (${overview.delivery === 'file-drop' ? 'load folder' : 'simulated'}).`,
      );
    } else {
      if (!reason.trim()) {
        tell('Enter a reason before pausing or resuming a batch.');
        return;
      }
      await api(`/batches/${batch.id}/${action}`, 'POST', { reason });
      tell(`Batch ${action === 'pause' ? 'paused' : 'resumed'}.`);
    }
    await refresh();
  }
  function fieldInput(field: Field, path: string) {
    const value = get(draft, path) ?? '',
      disabled = !lease || busy || (selected?.record.state === 'amendment_pending' && !isReviewer);
    const inputId = `field-${path}`;
    return (
      <label key={path} className="field" htmlFor={inputId}>
        <span>
          {field.label}
          {(field.required || (field.requiredWhen && compile(field.requiredWhen)(draft))) && (
            <b aria-label="required"> *</b>
          )}
          {field.declaredBy && <small>Customer supplied</small>}
        </span>
        {field.type === 'select' ? (
          <select
            id={inputId}
            value={value}
            disabled={disabled}
            onChange={(e) => change(path, e.target.value)}
          >
            <option value="">Select...</option>
            {Object.entries(pack!.lookups[field.options!.replace('lookup:', '')]).map(
              ([key, text]) => (
                <option key={key} value={key}>
                  {text}
                </option>
              ),
            )}
          </select>
        ) : field.type === 'boolean' ? (
          <select
            id={inputId}
            value={String(value)}
            disabled={disabled}
            onChange={(e) => change(path, e.target.value === '' ? null : e.target.value === 'true')}
          >
            <option value="">Not supplied</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        ) : (
          <input
            id={inputId}
            value={value}
            type={
              field.type === 'date'
                ? 'date'
                : ['number', 'currency'].includes(field.type)
                  ? 'number'
                  : 'text'
            }
            step={field.type === 'currency' ? '0.01' : undefined}
            readOnly={disabled}
            maxLength={5000}
            inputMode={field.widget === 'abn' ? 'numeric' : undefined}
            onChange={(e) =>
              change(
                path,
                ['number', 'currency'].includes(field.type)
                  ? e.target.value === ''
                    ? null
                    : Number(e.target.value)
                  : e.target.value,
              )
            }
          />
        )}
      </label>
    );
  }
  return (
    <div className="desktop">
      <div className="app-window raised">
        <header>
          <div className="titlebar">
            <span className="appmark">M</span>
            <strong>MIGTOOL</strong>
            <span className="title-sub">Bank 1 to Bank 2 migration</span>
            <span className="title-end">
              {user.username} / {label(user.role)}
            </span>
          </div>
          <div className="menubar">
            <button onClick={() => run(() => navigate('import'))} disabled={!isAdmin}>
              File
            </button>
            <button onClick={() => run(() => navigate('records'))}>Records</button>
            <button onClick={() => run(() => navigate('batches'))}>Operations</button>
            <button onClick={() => run(() => navigate('config'))}>Configuration</button>
            <div className="menu-right">
              <span>WORKSPACE: {user.demo ? 'SYNTHETIC DEMO' : 'LOCAL'}</span>
              <button
                onClick={() =>
                  run(async () => {
                    await release();
                    await api('/logout', 'POST', {});
                    setSelected(null);
                    setUser(null);
                  })
                }
              >
                Sign out
              </button>
            </div>
          </div>
          <div className="toolbar">
            <button disabled={busy || !isAdmin} onClick={() => run(() => navigate('import'))}>
              <Icon name="import" />
              Import extract
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await refresh();
                  tell('Workspace refreshed.');
                })
              }
            >
              Refresh
            </button>
            <span className="toolbar-separator" />
            <a className="button" href="/api/dashboard.pdf" download>
              Export progress PDF
            </a>
            <span className="toolbar-note">
              {overview.records.length} customers / {overview.batches.length} batches
            </span>
          </div>
        </header>
        <div className="workspace">
          <aside className="sidebar">
            <div className="sidebar-label">MIGRATION WORKSPACE</div>
            <nav aria-label="Main navigation">
              {nav.map(([key, text]) => (
                <button
                  key={key}
                  className={view === key ? 'active' : ''}
                  aria-current={view === key ? 'page' : undefined}
                  onClick={() => run(() => navigate(key))}
                >
                  <Icon name={key} />
                  {text}
                  {key === 'queue' && <span className="nav-count">{d.openExceptions}</span>}
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="system-box">
                <strong>CONNECTION STATUS</strong>
                <p>
                  <span className="square" />{' '}
                  {connected ? 'Backend connected' : 'Connection interrupted'}
                </p>
                <p>
                  CBS:{' '}
                  {overview?.delivery === 'file-drop' ? 'load folder (no live link)' : 'simulation'}
                </p>
                <p>AI steering: disabled</p>
              </div>
              <span className="version">MIGTOOL / VERSION 0.1.0</span>
            </div>
          </aside>
          <main id="main">
            <div className="page-heading">
              <div className="eyebrow">
                OPERATIONS /{' '}
                {selected
                  ? 'CUSTOMER RECORD'
                  : nav.find(([key]) => key === view)?.[1].toUpperCase()}
              </div>
              <h1>
                {selected
                  ? selected.record.data.entity?.legalName
                  : nav.find(([key]) => key === view)?.[1]}
              </h1>
              <p>
                {selected
                  ? `${selected.record.recordId} | Record version ${selected.etag} | ${selected.record.schemaVersion}`
                  : view === 'queue'
                    ? 'Resolve missing information and exceptions before migration.'
                    : view === 'dashboard'
                      ? 'Migration progress, readiness and operational controls.'
                      : view === 'import'
                        ? 'Ingest a structured Bank 1 extract. All rows are checked before processing.'
                        : view === 'records'
                          ? 'Review customer readiness, application gates and record ownership.'
                          : view === 'batches'
                            ? 'Release ready records, review control totals and manage batch state.'
                            : view === 'trace'
                              ? 'Follow a record from its source extract through every decision.'
                              : view === 'config'
                                ? 'Versioned domain configuration. Changes are made through reviewed pull requests.'
                                : 'Manage workspace access and edit leases.'}
              </p>
            </div>
            {selected ? (
              <>
                <div className="record-toolbar">
                  <Badge value={selected.record.state} />
                  <span className="lease-indicator">
                    {lease
                      ? `Checked out by you until ${date(lease.expiresAt)}`
                      : overview.leases.find((l: any) => l.recordId === selected.record.recordId)
                        ? `Read only: in use by ${overview.leases.find((l: any) => l.recordId === selected.record.recordId).holder}`
                        : 'Read only'}
                  </span>
                  <button onClick={() => run(closeRecord)}>Close record</button>
                  {!lease &&
                    !['exported', 'loaded', 'reconciled', 'withdrawn'].includes(
                      selected.record.state,
                    ) && (
                      <button onClick={() => run(() => openRecord(selected.record.recordId))}>
                        Acquire edit lease
                      </button>
                    )}
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !lease ||
                      (selected.record.state === 'amendment_pending' && !isReviewer)
                    }
                    onClick={() => run(save)}
                  >
                    {selected.record.state === 'amendment_pending'
                      ? 'Save proposed amendment'
                      : 'Save and validate'}
                  </button>
                </div>
                {savedDraft && (
                  <div className="notice">
                    <strong>Unsaved draft available</strong> from {date(savedDraft.at)}.{' '}
                    {savedDraft.etag !== selected.etag
                      ? 'The saved record has changed; restoring keeps the old version token so stale saves are rejected.'
                      : ''}
                    <button
                      onClick={() => {
                        setDraft(savedDraft.data);
                        setSelected({ ...selected, etag: savedDraft.etag });
                        dirty.current = true;
                        setSavedDraft(null);
                        tell('Unsaved draft restored.');
                      }}
                    >
                      Restore draft
                    </button>
                    <button
                      onClick={() => {
                        sessionStorage.removeItem(`draft:${user.id}:${selected.record.recordId}`);
                        setSavedDraft(null);
                      }}
                    >
                      Discard draft
                    </button>
                  </div>
                )}
                {selected.record.conflicts.length > 0 && (
                  <div className="notice">
                    <strong>Refresh conflicts require review</strong>
                    <p>
                      The current values have been kept. A reviewer can enter the chosen values and
                      save to resolve these conflicts.
                    </p>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Field</th>
                            <th>Previous extract</th>
                            <th>Current value</th>
                            <th>New extract</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selected.record.conflicts.map((c) => (
                            <tr key={c.path}>
                              <td>{c.path}</td>
                              <td>{JSON.stringify(c.baseline)}</td>
                              <td>{JSON.stringify(c.current)}</td>
                              <td>{JSON.stringify(c.incoming)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {selected.record.missingFromRefresh && (
                  <div className="notice">
                    <strong>Absent from the latest full snapshot.</strong>
                    <p>A reviewer must confirm whether this customer remains in scope.</p>
                    {isReviewer && lease && (
                      <>
                        <input
                          aria-label="Scope review reason"
                          placeholder="Reason for scope decision"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                        {['keep', 'withdraw'].map((decision) => (
                          <button
                            key={decision}
                            onClick={() =>
                              run(async () => {
                                await api(`/records/${selected.record.recordId}/scope`, 'POST', {
                                  decision,
                                  reason,
                                  leaseToken: lease.leaseToken,
                                });
                                leaseRef.current = null;
                                setLease(null);
                                await openRecord(selected.record.recordId);
                              })
                            }
                          >
                            {decision === 'keep' ? 'Keep in scope' : 'Mark withdrawn'}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
                {selected.record.state === 'amendment_pending' && (
                  <div className="notice">
                    <strong>Post-load amendment pending</strong>
                    <p>
                      The loaded record is frozen. The proposed changes need reviewer approval, CBS
                      delivery and readback.
                    </p>
                    <a href={`/api/records/${selected.record.recordId}/amendment.pdf`} download>
                      Download amendment review PDF
                    </a>
                    <details>
                      <summary>Proposed data</summary>
                      <pre>{JSON.stringify(selected.record.pendingData, null, 2)}</pre>
                    </details>
                    {isReviewer &&
                      lease &&
                      ['approve', 'reject'].map((decision) => (
                        <button
                          key={decision}
                          onClick={() =>
                            run(async () => {
                              await api(`/records/${selected.record.recordId}/amendment`, 'POST', {
                                decision,
                                leaseToken: lease.leaseToken,
                              });
                              leaseRef.current = null;
                              setLease(null);
                              await openRecord(selected.record.recordId);
                            })
                          }
                        >
                          {label(decision)} amendment
                        </button>
                      ))}
                  </div>
                )}
                <div className="gate-row">
                  <div>
                    <strong>COMPLETENESS</strong>
                    <b>{local!.score}%</b>
                  </div>
                  {Object.entries(local!.gates).map(([key, g]) => (
                    <div key={key}>
                      <strong>{key.toUpperCase()} GATE</strong>
                      <span>
                        {g.open ? 'OPEN' : 'CLOSED'} / {g.blockingRules.length} blockers
                      </span>
                    </div>
                  ))}
                  <div>
                    <strong>OUTPUT</strong>
                    <a
                      href={`/api/records/${selected.record.recordId}/bundle`}
                      download
                      onClick={(e) => {
                        if (!['exported', 'loaded', 'reconciled'].includes(selected.record.state)) {
                          e.preventDefault();
                          tell(
                            'Release a CBS-ready record through Batch control to create its bundle.',
                          );
                        }
                      }}
                    >
                      Download bundle
                    </a>
                  </div>
                </div>
                <div className="editor-layout">
                  <nav className="page-tabs" aria-label="Application sections">
                    {pack.schema.pages
                      .filter((p) => !p.enabledWhen || compile(p.enabledWhen)(draft))
                      .map((p) => (
                        <button
                          key={p.id}
                          className={page === p.id ? 'current' : ''}
                          onClick={() => setPage(p.id)}
                        >
                          {p.title}
                          {local!.rules.some(
                            (r) => !r.passed && p.sections.some((s) => s.id === r.section),
                          ) && <span aria-label="has errors">!</span>}
                        </button>
                      ))}
                  </nav>
                  <div className="form-panel inset">
                    {pack.schema.pages
                      .filter(
                        (p) => p.id === page && (!p.enabledWhen || compile(p.enabledWhen)(draft)),
                      )
                      .map((p) => (
                        <div key={p.id}>
                          <h2>{p.title}</h2>
                          {p.sections.map((section) => (
                            <fieldset key={section.id}>
                              <legend>{section.title}</legend>
                              {section.collection ? (
                                <>
                                  {(get(draft, section.collection.path) ?? []).map(
                                    (item: Data, index: number) => (
                                      <div className="collection-item" key={index}>
                                        <div className="collection-heading">
                                          <strong>Entry {index + 1}</strong>
                                          <button
                                            disabled={
                                              !lease ||
                                              get(draft, section.collection!.path).length <=
                                                section.collection!.min
                                            }
                                            onClick={() =>
                                              change(
                                                section.collection!.path,
                                                get(draft, section.collection!.path).filter(
                                                  (_: any, i: number) => i !== index,
                                                ),
                                              )
                                            }
                                          >
                                            Remove
                                          </button>
                                        </div>
                                        <div className="field-grid">
                                          {section.fields
                                            .filter((f) =>
                                              visible(
                                                pack,
                                                `${section.collection!.path}[${index}].${f.path}`,
                                                draft,
                                              ),
                                            )
                                            .map((f) =>
                                              fieldInput(
                                                f,
                                                `${section.collection!.path}[${index}].${f.path}`,
                                              ),
                                            )}
                                        </div>
                                      </div>
                                    ),
                                  )}
                                  <button
                                    disabled={
                                      !lease ||
                                      (get(draft, section.collection.path)?.length ?? 0) >=
                                        section.collection.max
                                    }
                                    onClick={() =>
                                      change(section.collection!.path, [
                                        ...(get(draft, section.collection!.path) ?? []),
                                        {},
                                      ])
                                    }
                                  >
                                    Add entry
                                  </button>
                                  <span className="collection-limit">
                                    {section.collection.min} to {section.collection.max} entries
                                  </span>
                                </>
                              ) : (
                                <div className="field-grid">
                                  {section.fields
                                    .filter((f) => visible(pack, f.path, draft))
                                    .map((f) => fieldInput(f, f.path))}
                                </div>
                              )}
                            </fieldset>
                          ))}
                        </div>
                      ))}
                    <div className="validation-panel">
                      <h3>Validation results</h3>
                      {local!.rules.filter((r) => !r.passed).length === 0 ? (
                        <p>All rules pass. Both gates are open.</p>
                      ) : (
                        local!.rules
                          .filter((r) => !r.passed)
                          .map((r) => (
                            <button
                              key={r.id}
                              className="validation-item"
                              onClick={() => {
                                setPage(
                                  pack.schema.pages.find((p) =>
                                    p.sections.some((s) => s.id === r.section),
                                  )?.id ?? page,
                                );
                              }}
                            >
                              <span>{r.severity.toUpperCase()}</span>
                              {r.message}
                              <code>{r.id}</code>
                            </button>
                          ))
                      )}
                    </div>
                  </div>
                </div>
                <div className="editor-footer">
                  <span>
                    * Required field. Customer-supplied fields must come from customer
                    documentation.
                  </span>
                  <button
                    onClick={() =>
                      run(async () => {
                        await closeRecord();
                        setTraceSearch(selected.record.recordId);
                        setView('trace');
                      })
                    }
                  >
                    View audit trace
                  </button>
                  {isReviewer && (
                    <a
                      className="button"
                      href={`/api/records/${selected.record.recordId}/playbook-draft`}
                      download
                    >
                      Prepare playbook review
                    </a>
                  )}
                </div>
              </>
            ) : (
              <>
                {['dashboard', 'queue', 'records'].includes(view) && (
                  <div className="metrics">
                    {[
                      ['TOTAL CUSTOMERS', d.total, 'Across all batches'],
                      ['CBS READY', d.states.cbs_ready ?? 0, 'Passed both gates'],
                      [
                        'OPEN EXCEPTIONS',
                        d.openExceptions,
                        `${d.agedExceptions} older than 48 hours`,
                      ],
                      ['RECONCILED', d.reconciled, 'Simulated CBS readback'],
                    ].map(([name, value, note]) => (
                      <div className="metric raised" key={name}>
                        <span>{name}</span>
                        <strong>{value}</strong>
                        <small>{note}</small>
                      </div>
                    ))}
                  </div>
                )}
                {view === 'queue' && (
                  <section className="panel raised">
                    <div className="panel-heading">
                      <h2>Exception worklist</h2>
                      <span>{exceptions.length} items</span>
                    </div>
                    <div className="filters">
                      <label className="search-field">
                        Search
                        <input
                          placeholder="Customer ID, issue or code"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </label>
                      <label>
                        Tier
                        <select value={tier} onChange={(e) => setTier(e.target.value)}>
                          <option value="all">All tiers</option>
                          {[0, 1, 2, 3, 4].map((t) => (
                            <option key={t} value={t}>
                              Tier {t}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Class
                        <select value={errorClass} onChange={(e) => setErrorClass(e.target.value)}>
                          <option value="all">All classes</option>
                          {[
                            'data',
                            'gap',
                            'mapping',
                            'conflict',
                            'system',
                            'transient',
                            'rule',
                          ].map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Age
                        <select value={age} onChange={(e) => setAge(e.target.value)}>
                          <option value="all">Any age</option>
                          <option value="24">Over 24 hours</option>
                          <option value="48">Over 48 hours</option>
                        </select>
                      </label>
                      <label>
                        Assignment
                        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                          <option value="all">Everyone</option>
                          <option value="mine">Assigned to me</option>
                          <option value="none">Unassigned</option>
                        </select>
                      </label>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Customer / error</th>
                            <th>Issue</th>
                            <th>Class</th>
                            <th>Tier</th>
                            <th>Raised</th>
                            <th>Assignee</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {exceptions.slice(0, 200).map((e: any) => (
                            <tr key={e.id}>
                              <td>
                                <strong>{e.recordId}</strong>
                                <small className="cell-note">{e.code}</small>
                              </td>
                              <td className="issue-cell">{e.message}</td>
                              <td>{label(e.errorClass)}</td>
                              <td>{e.tier}</td>
                              <td className="nowrap">{date(e.createdAt)}</td>
                              <td>{e.assignee || 'Unassigned'}</td>
                              <td className="actions-cell">
                                <button
                                  disabled={
                                    busy ||
                                    !overview.records.some((r: any) => r.recordId === e.recordId)
                                  }
                                  onClick={() => run(() => openRecord(e.recordId))}
                                >
                                  Open
                                </button>
                                {!e.assignee && (
                                  <button
                                    title="Assign this exception to me"
                                    onClick={() =>
                                      run(async () => {
                                        await api(`/exceptions/${e.id}/assign`, 'POST', {
                                          assignee: user.username,
                                        });
                                        await refresh();
                                      })
                                    }
                                  >
                                    Take
                                  </button>
                                )}
                                {pack.playbook.entries.some(
                                  (p) => p.match.errorCode === e.code,
                                ) && (
                                  <button
                                    disabled={busy}
                                    onClick={() =>
                                      run(async () => {
                                        await api(`/records/${e.recordId}/playbook`, 'POST', {
                                          code: e.code,
                                        });
                                        await refresh();
                                        tell('Approved playbook fix applied and revalidated.');
                                      })
                                    }
                                  >
                                    Apply fix
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!exceptions.length && (
                        <div className="empty">
                          <Icon name="queue" />
                          <h3>{d.total ? 'No matching exceptions' : 'Your workspace is ready'}</h3>
                          <p>
                            {d.total
                              ? 'Change the filters or open a customer record.'
                              : 'Import a Bank 1 extract to start checking customer readiness.'}
                          </p>
                          {isAdmin && (
                            <button onClick={() => setView('import')}>Import an extract</button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="panel-foot">
                      {exceptions.length > 200
                        ? 'Showing the first 200 matching exceptions. Narrow the filters to find other items.'
                        : 'Every fix is revalidated. Customer declarations require operator input.'}
                    </div>
                  </section>
                )}
                {view === 'records' && (
                  <section className="panel raised">
                    <div className="panel-heading">
                      <h2>Customer register</h2>
                      <span>{filteredRecords.length} records</span>
                    </div>
                    <div className="filters">
                      <label className="search-field">
                        Search
                        <input
                          placeholder="Customer name or ID"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </label>
                      <label>
                        State
                        <select
                          value={stateFilter}
                          onChange={(e) => setStateFilter(e.target.value)}
                        >
                          <option value="all">All states</option>
                          {Object.keys(d.states).map((s) => (
                            <option value={s} key={s}>
                              {label(s)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Customer ID</th>
                            <th>Legal name</th>
                            <th>State</th>
                            <th>Score</th>
                            <th>Version</th>
                            <th>Ownership</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredRecords.map((r: any) => (
                            <tr key={r.recordId}>
                              <td className="mono">{r.recordId}</td>
                              <td>
                                <strong>{r.name}</strong>
                              </td>
                              <td>
                                <Badge value={r.state} />
                              </td>
                              <td>{r.score}%</td>
                              <td>{r.version}</td>
                              <td>
                                {overview.leases.find((l: any) => l.recordId === r.recordId)
                                  ?.holder ?? 'Available'}
                              </td>
                              <td>
                                <button
                                  disabled={busy}
                                  onClick={() => run(() => openRecord(r.recordId))}
                                >
                                  Open record
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!filteredRecords.length && (
                        <div className="empty">
                          <h3>No customer records</h3>
                          <p>Import an extract or change the current filters.</p>
                        </div>
                      )}
                    </div>
                  </section>
                )}
                {view === 'dashboard' && (
                  <>
                    <div className="dashboard-grid">
                      <section className="panel raised">
                        <div className="panel-heading">
                          <h2>Readiness by state</h2>
                          <span>{d.total} customers</span>
                        </div>
                        <div className="state-breakdown">
                          {Object.entries(d.states).map(([state, count]) => (
                            <div key={state}>
                              <span>{label(state)}</span>
                              <div className="bar-track">
                                <div
                                  className="bar-fill"
                                  style={{
                                    width: `${(100 * Number(count)) / Math.max(d.total, 1)}%`,
                                  }}
                                />
                              </div>
                              <b>{String(count)}</b>
                            </div>
                          ))}
                          {!d.total && <p>State counts will appear after the first import.</p>}
                        </div>
                      </section>
                      <section className="panel raised">
                        <div className="panel-heading">
                          <h2>Quality and throughput</h2>
                        </div>
                        <dl className="quality-list">
                          <div>
                            <dt>Straight-through rate</dt>
                            <dd>{d.straightThroughRate}%</dd>
                          </div>
                          <div>
                            <dt>Exceptions older than 48 hours</dt>
                            <dd>{d.agedExceptions}</dd>
                          </div>
                          <div>
                            <dt>Readback mismatches</dt>
                            <dd>{d.defects}</dd>
                          </div>
                          <div>
                            <dt>Batches</dt>
                            <dd>{d.batches}</dd>
                          </div>
                        </dl>
                        <div className="panel-foot">
                          Straight-through: reconciled records with no operator edit.
                        </div>
                      </section>
                    </div>
                    <section className="panel raised">
                      <div className="panel-heading">
                        <h2>Migration controls</h2>
                      </div>
                      <div className="control-grid">
                        <div>
                          <strong>01 / IMPORT</strong>
                          <p>Idempotent rows, stable customer keys and verified control totals.</p>
                        </div>
                        <div>
                          <strong>02 / RESOLVE</strong>
                          <p>Versioned edits under a server-side lease. No silent overwrites.</p>
                        </div>
                        <div>
                          <strong>03 / RELEASE</strong>
                          <p>
                            AAF and CBS gates control exports. CBS load files are written to a local
                            load folder; there is no live bank connection.
                          </p>
                        </div>
                        <div>
                          <strong>04 / VERIFY</strong>
                          <p>Persisted readback, file hashes and an append-only trace.</p>
                        </div>
                      </div>
                    </section>
                  </>
                )}
                {view === 'import' && (
                  <>
                    <section className="panel raised">
                      <div className="panel-heading">
                        <h2>Import Bank 1 extract</h2>
                        <span>JSON / SYNTHETIC DOMAIN PACK</span>
                      </div>
                      <div className="import-body">
                        <div className="step-label">1A. BANK 1 CSV EXTRACT PACKAGE</div>
                        <p>
                          Select every file of the package together: <code>customers.csv</code>,{' '}
                          <code>accounts.csv</code>, <code>people.csv</code>,{' '}
                          <code>signatories.csv</code> and <code>control.csv</code> (row counts and
                          SHA-256 per file). A file fault stops the whole batch.
                        </p>
                        <input
                          aria-label="CSV extract files"
                          type="file"
                          multiple
                          accept=".csv,text/csv"
                          disabled={!isAdmin || busy}
                          onChange={(event) =>
                            run(async () => {
                              setImportData(null);
                              setCsvImport(null);
                              setImportError('');
                              const list = [...(event.target.files ?? [])];
                              if (!list.length) return;
                              try {
                                // Keep a byte order mark so file checksums match control.csv.
                                const decoder = new TextDecoder('utf-8', {
                                  fatal: true,
                                  ignoreBOM: true,
                                });
                                const files = Object.fromEntries(
                                  await Promise.all(
                                    list.map(async (f) => [
                                      f.name,
                                      decoder.decode(await f.arrayBuffer()),
                                    ]),
                                  ),
                                );
                                setCsvImport({ files, name: 'Bank 1 CSV extract' });
                                tell(`${list.length} CSV files selected. Review before import.`);
                              } catch (e) {
                                setImportError(
                                  e instanceof TypeError
                                    ? 'Files must be UTF-8 encoded'
                                    : (e as Error).message,
                                );
                              }
                            })
                          }
                        />
                        <div className="sample-actions">
                          <button
                            disabled={!isAdmin || busy}
                            onClick={() =>
                              run(async () => {
                                setImportData(null);
                                setCsvImport({
                                  files: await api('/fixtures/csv'),
                                  name: 'Example Bank 1 CSV extract (10 customers)',
                                });
                                tell('Example 10-customer CSV extract selected. Review below.');
                              })
                            }
                          >
                            Use example CSV extract
                          </button>
                        </div>
                        {csvImport && (
                          <div className="import-review inset">
                            <div className="step-label">REVIEW CSV PACKAGE</div>
                            <dl>
                              <div>
                                <dt>Extract</dt>
                                <dd>{csvImport.name}</dd>
                              </div>
                              {Object.entries(csvImport.files)
                                .sort(([a], [b]) => a.localeCompare(b))
                                .map(([name, text]) => (
                                  <div key={name}>
                                    <dt>{name}</dt>
                                    <dd>
                                      {Math.max(text.trim().split(/\r?\n/).length - 1, 0)} rows
                                    </dd>
                                  </div>
                                ))}
                            </dl>
                            <p>
                              Control totals and checksums are verified on the server. Customer
                              declarations are never imported.
                            </p>
                            <button
                              className="primary"
                              disabled={busy || !isAdmin}
                              onClick={() =>
                                run(async () => {
                                  tell(
                                    'Import in progress. Verifying files and converting rows...',
                                  );
                                  const result = await api('/ingest/csv', 'POST', csvImport);
                                  await refresh();
                                  setCsvImport(null);
                                  setView('batches');
                                  tell(
                                    `Import ${label(result.state).toLowerCase()}: ${result.counts.created} created, ${result.counts.updated} updated, ${result.counts.skipped} unchanged, ${result.counts.rejected} rejected.`,
                                  );
                                })
                              }
                            >
                              {busy ? 'Processing extract...' : 'Import CSV and validate'}
                            </button>
                          </div>
                        )}
                        <div className="step-label">1B. JSON EXTRACT</div>
                        <p>
                          Use a UTF-8 JSON file containing <code>rows</code> and{' '}
                          <code>totals.customerCount / accountCount</code>. Repeating account,
                          people and signatory groups are arrays.
                        </p>
                        <input
                          aria-label="Extract file"
                          type="file"
                          accept=".json,application/json"
                          disabled={!isAdmin || busy}
                          onChange={(event) =>
                            run(async () => {
                              setImportData(null);
                              setCsvImport(null);
                              setImportError('');
                              const file = event.target.files?.[0];
                              if (!file) return;
                              try {
                                if (file.size > 20 * 1024 * 1024)
                                  throw new Error('Maximum file size is 20 MB');
                                const parsed = JSON.parse(await file.text());
                                if (!Array.isArray(parsed.rows) || !parsed.totals)
                                  throw new Error('Expected rows and control totals');
                                setImportData(parsed);
                                tell(`${file.name} selected. Review totals before import.`);
                              } catch (e) {
                                setImportError((e as Error).message);
                              }
                            })
                          }
                        />
                        <div className="sample-actions">
                          <a href="/api/fixtures/extract" download>
                            Download 200-customer example
                          </a>
                          <a href="/api/fixtures/refresh" download>
                            Download refresh example
                          </a>
                          <button
                            disabled={!isAdmin || busy}
                            onClick={() =>
                              run(async () => {
                                setImportData(await api('/fixtures/extract'));
                                tell(
                                  'Synthetic 200-customer extract selected. Review and import below.',
                                );
                              })
                            }
                          >
                            Use example extract
                          </button>
                        </div>
                        {importError && (
                          <p className="error" role="alert">
                            {importError}
                          </p>
                        )}
                        {importData && (
                          <div className="import-review inset">
                            <div className="step-label">2. REVIEW CONTROL TOTALS</div>
                            <dl>
                              <div>
                                <dt>Extract</dt>
                                <dd>{importData.name ?? 'Unnamed extract'}</dd>
                              </div>
                              <div>
                                <dt>Expected customers</dt>
                                <dd>{importData.totals.customerCount}</dd>
                              </div>
                              <div>
                                <dt>Actual rows</dt>
                                <dd>{importData.rows.length}</dd>
                              </div>
                              <div>
                                <dt>Expected accounts</dt>
                                <dd>{importData.totals.accountCount}</dd>
                              </div>
                              <div>
                                <dt>Import mode</dt>
                                <dd>
                                  {importData.fullSnapshot
                                    ? 'Full snapshot refresh'
                                    : 'Create / refresh supplied rows'}
                                </dd>
                              </div>
                            </dl>
                            <p>
                              Customer declarations are left empty. Missing values are sent to the
                              exception queue.
                            </p>
                            <button
                              className="primary"
                              disabled={busy || !isAdmin}
                              onClick={() =>
                                run(async () => {
                                  tell(
                                    'Import in progress. Validating rows and recording provenance...',
                                  );
                                  const result = await api('/ingest', 'POST', importData);
                                  await refresh();
                                  setImportData(null);
                                  setView('batches');
                                  tell(
                                    `Import ${label(result.state).toLowerCase()}: ${result.counts.created} created, ${result.counts.updated} updated, ${result.counts.skipped} unchanged, ${result.counts.rejected} rejected.`,
                                  );
                                })
                              }
                            >
                              {busy ? 'Processing extract...' : 'Import and validate'}
                            </button>
                          </div>
                        )}
                      </div>
                    </section>
                    <div className="notice">
                      <strong>Illustrative mappings</strong>
                      <p>
                        The current configuration uses placeholder Bank 1 / Bank 2 fields and
                        synthetic products. Actual extract columns, CBS specifications and the
                        official AAF template are integration inputs.
                      </p>
                      {!isAdmin && <p>An administrator must import extracts.</p>}
                    </div>
                  </>
                )}
                {view === 'batches' && (
                  <section className="panel raised">
                    <div className="panel-heading">
                      <h2>Batch register</h2>
                      <span>
                        CBS DELIVERY:{' '}
                        {overview.delivery === 'file-drop' ? 'LOAD FOLDER' : 'SIMULATED'}
                      </span>
                    </div>
                    <div className="filters">
                      <label className="search-field">
                        Operational reason
                        <input
                          placeholder="Required to pause or resume a batch"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </label>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Batch / created</th>
                            <th>State</th>
                            <th>Source</th>
                            <th>Accounts</th>
                            <th>Created</th>
                            <th>Updated</th>
                            <th>Skipped</th>
                            <th>Rejected</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {overview.batches.map((b: any) => (
                            <tr key={b.id}>
                              <td>
                                <strong>{b.name}</strong>
                                <small className="cell-note">
                                  {date(b.createdAt)} / {b.id.slice(0, 8)}
                                </small>
                                {b.reason && <small className="cell-note">{b.reason}</small>}
                              </td>
                              <td>
                                <Badge value={b.state} />
                              </td>
                              {[
                                'source',
                                'accounts',
                                'created',
                                'updated',
                                'skipped',
                                'rejected',
                              ].map((key) => (
                                <td key={key}>{b.counts[key]}</td>
                              ))}
                              <td className="actions-cell">
                                <button
                                  disabled={!isAdmin || busy || b.state === 'on_hold'}
                                  onClick={() => run(() => batchAction(b, 'release'))}
                                >
                                  Release ready
                                </button>
                                <button
                                  disabled={!isAdmin || busy}
                                  onClick={() =>
                                    run(() =>
                                      batchAction(b, b.state === 'on_hold' ? 'resume' : 'pause'),
                                    )
                                  }
                                >
                                  {b.state === 'on_hold' ? 'Resume' : 'Pause'}
                                </button>
                                {isReviewer && (
                                  <a
                                    className="button"
                                    href={`/api/batches/${encodeURIComponent(b.id)}/cbs-export`}
                                    download
                                  >
                                    CBS load files
                                  </a>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!overview.batches.length && (
                        <div className="empty">
                          <h3>No batches imported</h3>
                          <p>Import a source extract to create the first batch.</p>
                        </div>
                      )}
                    </div>
                    <div className="panel-foot">
                      Release queues only CBS-ready records without unresolved conflicts. No live
                      bank connection is configured.
                    </div>
                  </section>
                )}
                {view === 'trace' && (
                  <section className="panel raised">
                    <div className="panel-heading">
                      <h2>Append-only event log</h2>
                      <span>{trace.length} events / latest 5,000 maximum</span>
                    </div>
                    <div className="filters">
                      <label className="search-field">
                        Customer ID
                        <input
                          placeholder="Exact customer ID, or leave blank"
                          value={traceSearch}
                          onChange={(e) => setTraceSearch(e.target.value)}
                        />
                      </label>
                      <button
                        onClick={() =>
                          run(async () => {
                            setTrace(
                              await api(
                                '/trace' +
                                  (traceSearch
                                    ? '?recordId=' + encodeURIComponent(traceSearch)
                                    : ''),
                              ),
                            );
                            tell('Audit trace refreshed.');
                          })
                        }
                      >
                        Query trace
                      </button>
                    </div>
                    {user.role === 'operator' && (
                      <div className="panel-foot">
                        Operators can view traces for records they have checked out or edited.
                      </div>
                    )}
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Customer</th>
                            <th>Version</th>
                            <th>Step</th>
                            <th>Decision</th>
                            <th>Actor</th>
                            <th>Evidence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trace.map((t) => (
                            <tr key={t.eventId}>
                              <td className="nowrap">{date(t.at)}</td>
                              <td className="mono">{t.recordId}</td>
                              <td>{t.recordVersion}</td>
                              <td>{label(t.step)}</td>
                              <td>{label(t.decision)}</td>
                              <td>
                                {t.actor.kind} / {t.actor.id.slice(0, 12)}
                              </td>
                              <td>
                                <details>
                                  <summary>Inspect</summary>
                                  <pre>{JSON.stringify(t, null, 2)}</pre>
                                </details>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!trace.length && (
                        <div className="empty">
                          <h3>No matching trace events</h3>
                          <p>Import or edit records to start the audit chain.</p>
                        </div>
                      )}
                    </div>
                  </section>
                )}
                {view === 'config' && (
                  <>
                    <div className="notice">
                      <strong>Configuration is read only</strong>
                      <p>
                        Schema {pack.schema.version}. {pack.schema.pages.length} generated pages,{' '}
                        {pack.rules.rules.length} explicit rules, {pack.mappings.length}{' '}
                        projections. Use <code>npm run check:config</code> before opening a
                        configuration pull request.
                      </p>
                    </div>
                    <section className="panel raised">
                      <div className="panel-heading">
                        <h2>Configuration fingerprints</h2>
                        <span>SHA-256</span>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>File</th>
                              <th>Content hash</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(pack.version).map(([file, digest]) => (
                              <tr key={file}>
                                <td>{file}</td>
                                <td className="mono hash">{digest}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                    <section className="panel raised">
                      <div className="panel-heading">
                        <h2>Gates and outputs</h2>
                      </div>
                      <div className="control-grid">
                        {Object.entries(pack.gates.gates).map(([key, gate]) => (
                          <div key={key}>
                            <strong>
                              {key.toUpperCase()} GATE / {gate.min_score}%
                            </strong>
                            <p>
                              Blocks: {gate.block_on.join(', ')}. Outputs: {gate.unlocks.join(', ')}
                            </p>
                          </div>
                        ))}
                      </div>
                    </section>
                  </>
                )}
                {view === 'admin' && isAdmin && (
                  <>
                    <section className="panel raised">
                      <div className="panel-heading">
                        <h2>Workspace users</h2>
                        <span>4-HOUR SESSIONS</span>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Username</th>
                              <th>Role</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {users.map((u) => (
                              <tr key={u.id}>
                                <td>{u.username}</td>
                                <td>{label(u.role)}</td>
                                <td>{u.disabled ? 'Disabled' : 'Active'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <form
                        className="user-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = event.currentTarget,
                            data = new FormData(form);
                          run(async () => {
                            await api('/users', 'POST', {
                              username: data.get('username'),
                              password: data.get('password'),
                              role: data.get('role'),
                            });
                            setUsers(await api('/users'));
                            form.reset();
                            tell('Workspace user created.');
                          });
                        }}
                      >
                        <label>
                          Username
                          <input
                            name="username"
                            minLength={3}
                            maxLength={40}
                            required
                            autoComplete="off"
                          />
                        </label>
                        <label>
                          Initial password
                          <input
                            type="password"
                            name="password"
                            minLength={12}
                            required
                            autoComplete="new-password"
                          />
                        </label>
                        <label>
                          Role
                          <select name="role">
                            <option>operator</option>
                            <option>reviewer</option>
                            <option>admin</option>
                          </select>
                        </label>
                        <button disabled={busy}>Create user</button>
                      </form>
                    </section>
                    <section className="panel raised">
                      <div className="panel-heading">
                        <h2>Active record leases</h2>
                        <span>{overview.leases.length} held</span>
                      </div>
                      <div className="filters">
                        <label className="search-field">
                          Reason for lease break
                          <input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Required for the audit log"
                          />
                        </label>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Record</th>
                              <th>Holder</th>
                              <th>Acquired</th>
                              <th>Expires</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overview.leases.map((l: any) => (
                              <tr key={l.recordId}>
                                <td>{l.recordId}</td>
                                <td>
                                  {l.holder} / {l.holderKind}
                                </td>
                                <td>{date(l.acquiredAt)}</td>
                                <td>{date(l.expiresAt)}</td>
                                <td>
                                  <button
                                    disabled={!reason.trim()}
                                    onClick={() =>
                                      run(async () => {
                                        await api(`/records/${l.recordId}/lease/break`, 'POST', {
                                          reason,
                                        });
                                        await refresh();
                                        tell(`Lease broken for ${l.recordId}.`);
                                      })
                                    }
                                  >
                                    Break lease
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!overview.leases.length && (
                          <div className="empty compact">No records are checked out.</div>
                        )}
                      </div>
                    </section>
                  </>
                )}
              </>
            )}
          </main>
        </div>
        <footer className="statusbar">
          <div className="status-message" role="status" aria-live="polite" ref={messageRef}>
            <span className="square" />
            {busy ? 'Working... ' : ''}
            {status}
          </div>
          <span>{user.role.toUpperCase()}</span>
          <span>NO LIVE CBS CONNECTION</span>
        </footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
