import { connectHost } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBanner,
  mountButton,
  mountEmpty,
  mountList,
  mountSearchField,
  mountSelect,
  mountSpinner,
  mountTabs,
  mountTextField,
  type ButtonHandle,
  type ListHandle,
  type ListItem,
  type SearchFieldHandle,
  type SelectHandle,
  type TextFieldHandle,
} from '@openchamber/sdk/ui';

type ResourceItem = ListItem & {
  name: string;
  namespace: string;
  kind: string;
  containers?: string[];
  customKind?: string;
  scope?: string;
  localPort?: number;
  target?: string;
};

type Bootstrap = {
  contexts: { id: string; label: string; hint?: string; namespace?: string }[];
  context: string;
  namespaces: string[];
};

type Section = {
  id: string;
  label: string;
};

const NAV: { label: string; items: Section[] }[] = [
  { label: 'Cluster', items: [
    { id: 'overview', label: 'Overview' },
    { id: 'nodes', label: 'Nodes' },
    { id: 'events', label: 'Events' },
  ] },
  { label: 'Workloads', items: [
    { id: 'pods', label: 'Pods' },
    { id: 'deployments', label: 'Deployments' },
    { id: 'statefulsets', label: 'StatefulSets' },
    { id: 'daemonsets', label: 'DaemonSets' },
    { id: 'jobs', label: 'Jobs' },
    { id: 'cronjobs', label: 'CronJobs' },
  ] },
  { label: 'Network', items: [
    { id: 'services', label: 'Services' },
    { id: 'ingresses', label: 'Ingresses' },
  ] },
  { label: 'Storage', items: [
    { id: 'pvc', label: 'PVC' },
    { id: 'pv', label: 'PersistentVolumes' },
    { id: 'storageclasses', label: 'StorageClasses' },
  ] },
  { label: 'Config', items: [
    { id: 'configmaps', label: 'ConfigMaps' },
    { id: 'secrets', label: 'Secrets' },
  ] },
  { label: 'More', items: [
    { id: 'helm', label: 'Helm Releases' },
    { id: 'crds', label: 'Custom Resources' },
    { id: 'ports', label: 'Port-forwards' },
  ] },
];

const SECTIONS = new Map(NAV.flatMap((group) => group.items).map((item) => [item.id, item.label]));
const CLUSTER_WIDE = new Set(['overview', 'nodes', 'pv', 'storageclasses', 'crds', 'ports']);
const host = connectHost();

const state = {
  ready: false,
  context: '',
  contexts: [] as Bootstrap['contexts'],
  namespaces: [] as string[],
  namespace: 'all',
  section: 'overview',
  search: '',
  items: [] as ResourceItem[],
  overview: { stats: [] as { label: string; value: string }[], version: '—', warnings: [] as ResourceItem[] },
  selected: null as ResourceItem | null,
  detailTab: '',
  detailText: '',
  detailItems: [] as ResourceItem[],
  detailLoading: false,
  detailError: '',
  loading: false,
  error: '',
  selectedContainer: '',
  command: '',
  execOutput: '',
  portTargets: [] as { id: string; label: string; ports: number[] }[],
  portTarget: '',
  localPort: '8080',
  remotePort: '80',
  selectedPortId: '',
};

let contentSequence = 0;
let detailSequence = 0;
let contextSelect: SelectHandle;
let namespaceSelect: SelectHandle;
let searchField: SearchFieldHandle;
let refreshButton: ButtonHandle;
const navHandles: ListHandle[] = [];

const root = document.querySelector<HTMLElement>('#root')!;
root.innerHTML = `
  <div class="app">
    <header class="topbar">
      <div class="brand">K8S</div>
      <div class="context" id="context"></div>
      <div class="refresh" id="refresh"></div>
    </header>
    <div class="global-banner" id="global-banner"></div>
    <div class="layout">
      <aside class="sidebar" id="sidebar"></aside>
      <main class="main">
        <div class="toolbar">
          <div class="section-heading"><h1 id="section-title">K8S</h1><p id="section-subtitle"></p></div>
          <div class="namespace" id="namespace"></div>
        </div>
        <div class="search" id="search"></div>
        <div class="content" id="content"></div>
        <section class="detail" id="detail" hidden></section>
      </main>
    </div>
  </div>`;

const sidebar = root.querySelector<HTMLElement>('#sidebar')!;
const content = root.querySelector<HTMLElement>('#content')!;
const detail = root.querySelector<HTMLElement>('#detail')!;
const globalBanner = root.querySelector<HTMLElement>('#global-banner')!;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function request<T>(method: 'GET' | 'POST', path: string, query?: Record<string, string>, body?: unknown): Promise<T> {
  const answer = await host.serviceRequest({ method, path, query, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: any = {};
  if (answer.body) {
    try { data = typeof answer.body === 'string' ? JSON.parse(answer.body) : answer.body; }
    catch { data = { error: String(answer.body) }; }
  }
  if (answer.status < 200 || answer.status >= 300) throw new Error(data.error || `Request failed with status ${answer.status}.`);
  return data as T;
}

function baseQuery(): Record<string, string> {
  return { context: state.context };
}

function renderGlobalError(message: string): void {
  globalBanner.replaceChildren();
  if (!message) return;
  mountBanner(globalBanner, {
    tone: 'error',
    title: 'Could not connect to Kubernetes',
    body: message,
    action: { label: 'Retry', onClick: () => void initialize(state.context || undefined) },
  });
}

function renderChrome(): void {
  root.querySelector('#section-title')!.textContent = SECTIONS.get(state.section) ?? 'K8S';
  const count = !['overview', 'ports'].includes(state.section) && state.items.length ? ` · ${state.items.length}` : '';
  root.querySelector('#section-subtitle')!.textContent = `${state.context || 'No context'}${count}`;
  navHandles.forEach((handle) => handle.update({ selectedId: state.section }));
  namespaceSelect.update({
    value: state.namespace,
    options: [{ id: 'all', label: 'All namespaces' }, ...state.namespaces.map((name) => ({ id: name, label: name }))],
  });
  root.querySelector<HTMLElement>('#namespace')!.style.display = CLUSTER_WIDE.has(state.section) ? 'none' : '';
  root.querySelector<HTMLElement>('#search')!.style.display = state.section === 'overview' ? 'none' : '';
  contextSelect.update({ options: state.contexts, value: state.context || null, disabled: !state.contexts.length });
}

async function initialize(requestedContext?: string): Promise<void> {
  state.loading = true;
  state.error = '';
  renderGlobalError('');
  renderContent();
  try {
    const data = await request<Bootstrap>('GET', '/api/bootstrap', requestedContext ? { context: requestedContext } : undefined);
    state.contexts = data.contexts;
    state.context = data.context;
    state.namespaces = data.namespaces;
    state.namespace = 'all';
    state.selected = null;
    state.selectedPortId = '';
    state.ready = true;
    renderChrome();
    await loadContent();
  } catch (error) {
    state.loading = false;
    state.ready = false;
    renderGlobalError(errorText(error));
    content.replaceChildren();
    const center = node('div', 'center');
    content.append(center);
    mountEmpty(center, {
      title: 'Kubernetes is unavailable',
      body: 'Check kubeconfig, the selected context, and API server access.',
      action: { label: 'Retry', onClick: () => void initialize(state.context || undefined) },
    });
    renderChrome();
  }
}

async function loadContent(): Promise<void> {
  if (!state.context) return;
  const sequence = ++contentSequence;
  state.loading = true;
  state.error = '';
  renderContent();
  try {
    if (state.section === 'overview') {
      const data = await request<typeof state.overview>('GET', '/api/overview', baseQuery());
      if (sequence !== contentSequence) return;
      state.overview = data;
    } else if (state.section === 'helm') {
      const data = await request<{ items: ResourceItem[] }>('GET', '/api/helm', { ...baseQuery(), namespace: state.namespace });
      if (sequence !== contentSequence) return;
      state.items = data.items;
    } else if (state.section === 'ports') {
      const [ports, targets] = await Promise.all([
        request<{ items: ResourceItem[] }>('GET', '/api/ports'),
        request<{ items: typeof state.portTargets }>('GET', '/api/port-targets', baseQuery()),
      ]);
      if (sequence !== contentSequence) return;
      state.items = ports.items;
      state.portTargets = targets.items;
      if (!state.portTargets.some((item) => item.id === state.portTarget)) {
        state.portTarget = state.portTargets[0]?.id ?? '';
        state.remotePort = String(state.portTargets[0]?.ports[0] ?? 80);
        state.localPort = state.remotePort;
      }
    } else {
      const data = await request<{ items: ResourceItem[] }>('GET', '/api/resources', {
        ...baseQuery(), section: state.section, namespace: state.namespace,
      });
      if (sequence !== contentSequence) return;
      state.items = data.items;
    }
  } catch (error) {
    if (sequence !== contentSequence) return;
    state.error = errorText(error);
  } finally {
    if (sequence === contentSequence) {
      state.loading = false;
      renderChrome();
      renderContent();
    }
  }
}

function filteredItems(): ResourceItem[] {
  const query = state.search.trim().toLowerCase();
  if (!query) return state.items;
  return state.items.filter((item) => `${item.title} ${item.subtitle ?? ''} ${item.badge?.label ?? ''}`.toLowerCase().includes(query));
}

function renderContent(): void {
  content.replaceChildren();
  content.classList.toggle('with-detail', Boolean(state.selected) && state.section !== 'ports');
  if (state.loading) {
    const center = node('div', 'center');
    content.append(center);
    mountSpinner(center, { label: 'Loading resources…' });
    return;
  }
  if (state.error) {
    mountBanner(content, {
      tone: 'error',
      title: 'Failed to load data',
      body: state.error,
      action: { label: 'Retry', onClick: () => void loadContent() },
    });
    return;
  }
  if (!state.ready) return;
  if (state.section === 'overview') {
    renderOverview();
    return;
  }
  if (state.section === 'ports') {
    renderPorts();
    return;
  }
  const items = filteredItems();
  if (!items.length) {
    mountEmpty(content, state.search
      ? { title: 'No matching resources', body: 'Change your search query or namespace.' }
      : { title: 'No resources', body: 'This list is empty in the selected namespace.' });
    return;
  }
  if (items.length > 300) {
    mountBanner(content, { tone: 'info', title: `Showing the first 300 of ${items.length}`, body: 'Narrow the list using search or a namespace.' });
  }
  const list = node('div');
  content.append(list);
  mountList(list, {
    items: items.slice(0, 300),
    selectedId: state.selected?.id,
    ariaLabel: SECTIONS.get(state.section),
    onSelect: (id) => {
      const item = state.items.find((candidate) => candidate.id === id);
      if (item) selectResource(item);
    },
  });
}

function renderOverview(): void {
  const stats = node('div', 'stats');
  for (const item of state.overview.stats) {
    const card = node('div', 'stat');
    card.append(node('div', 'stat-label', item.label), node('div', 'stat-value', item.value));
    stats.append(card);
  }
  content.append(stats);
  content.append(node('div', 'overview-meta', `${state.context} · ${state.overview.version}`));
  content.append(node('div', 'overview-title', 'Recent warnings'));
  if (!state.overview.warnings.length) {
    mountEmpty(content, { title: 'No warnings', body: 'The cluster has no new Warning events.' });
    return;
  }
  const list = node('div');
  content.append(list);
  mountList(list, { items: state.overview.warnings, ariaLabel: 'Warnings', onSelect: () => undefined });
}

function selectResource(item: ResourceItem): void {
  state.selected = item;
  state.selectedContainer = item.containers?.[0] ?? '';
  state.command = '';
  state.execOutput = '';
  state.detailText = '';
  state.detailItems = [];
  state.detailError = '';
  state.detailTab = item.kind === 'HelmRelease' ? 'manifest' : state.section === 'crds' ? 'instances' : state.section === 'pods' ? 'logs' : state.section === 'events' ? 'yaml' : 'events';
  renderContent();
  void loadDetail();
}

function closeDetail(): void {
  detailSequence += 1;
  state.selected = null;
  state.detailText = '';
  state.detailItems = [];
  detail.hidden = true;
  detail.replaceChildren();
  renderContent();
}

function detailTabs(): { id: string; label: string }[] {
  if (!state.selected) return [];
  if (state.selected.kind === 'HelmRelease') return [{ id: 'manifest', label: 'Manifest' }, { id: 'values', label: 'Values' }, { id: 'history', label: 'History' }];
  if (state.section === 'crds') return [{ id: 'instances', label: 'Instances' }, { id: 'yaml', label: 'YAML' }];
  if (state.section === 'pods') return [{ id: 'logs', label: 'Logs' }, { id: 'events', label: 'Events' }, { id: 'yaml', label: 'YAML' }, { id: 'terminal', label: 'Terminal' }];
  if (state.section === 'events') return [{ id: 'yaml', label: 'YAML' }];
  return [{ id: 'events', label: 'Events' }, { id: 'yaml', label: 'YAML' }];
}

async function loadDetail(): Promise<void> {
  const selected = state.selected;
  if (!selected) return;
  const sequence = ++detailSequence;
  state.detailLoading = state.detailTab !== 'terminal';
  state.detailError = '';
  state.detailText = '';
  state.detailItems = [];
  renderDetail();
  if (state.detailTab === 'terminal') return;
  try {
    const query: Record<string, string> = {
      ...baseQuery(), name: selected.name, namespace: selected.namespace, kind: selected.kind,
    };
    if (state.detailTab === 'yaml') {
      const data = await request<{ text: string }>('GET', '/api/yaml', { ...query, section: state.section });
      if (sequence === detailSequence) state.detailText = data.text;
    } else if (state.detailTab === 'logs') {
      const data = await request<{ text: string }>('GET', '/api/logs', { ...query, container: state.selectedContainer });
      if (sequence === detailSequence) state.detailText = data.text;
    } else if (state.detailTab === 'events') {
      const data = await request<{ items: ResourceItem[] }>('GET', '/api/events', query);
      if (sequence === detailSequence) state.detailItems = data.items;
    } else if (state.detailTab === 'instances') {
      const data = await request<{ items: ResourceItem[] }>('GET', '/api/custom-resources', {
        ...baseQuery(), crd: selected.name, kind: selected.customKind ?? '', scope: selected.scope ?? '',
      });
      if (sequence === detailSequence) state.detailItems = data.items;
    } else if (['manifest', 'values', 'history'].includes(state.detailTab)) {
      const data = await request<{ text: string }>('GET', '/api/helm-detail', { ...query, view: state.detailTab });
      if (sequence === detailSequence) state.detailText = data.text;
    }
  } catch (error) {
    if (sequence === detailSequence) state.detailError = errorText(error);
  } finally {
    if (sequence === detailSequence) {
      state.detailLoading = false;
      renderDetail();
    }
  }
}

function renderDetail(): void {
  const selected = state.selected;
  detail.replaceChildren();
  if (!selected) {
    detail.hidden = true;
    return;
  }
  detail.hidden = false;
  const head = node('div', 'detail-head');
  const name = node('div', 'detail-name');
  name.append(node('strong', undefined, selected.title), node('span', undefined, `${selected.kind}${selected.namespace ? ` · ${selected.namespace}` : ''}`));
  const actions = node('div', 'detail-actions');
  head.append(name, actions);
  detail.append(head);

  if (state.detailTab !== 'terminal' && state.detailTab !== 'events' && state.detailTab !== 'instances') {
    const copy = node('span');
    actions.append(copy);
    mountButton(copy, {
      label: 'Copy', variant: 'ghost', size: 'sm', disabled: !state.detailText,
      onClick: () => {
        void host.writeClipboard(state.detailText).then(() => host.toast({ kind: 'success', message: 'Copied' }));
      },
    });
  }
  if (state.detailTab === 'logs') {
    const reload = node('span');
    actions.append(reload);
    mountButton(reload, { label: 'Refresh', variant: 'ghost', size: 'sm', onClick: () => void loadDetail() });
  }
  const close = node('span');
  actions.append(close);
  mountButton(close, { label: 'Close', variant: 'ghost', size: 'sm', onClick: closeDetail });

  const tabs = node('div', 'detail-tabs');
  detail.append(tabs);
  mountTabs(tabs, {
    items: detailTabs(),
    activeId: state.detailTab,
    onChange: (id) => {
      state.detailTab = id;
      void loadDetail();
    },
  });
  const body = node('div', 'detail-body');
  detail.append(body);
  if (state.detailLoading) {
    const center = node('div', 'center');
    body.append(center);
    mountSpinner(center, { label: 'Loading…', size: 'sm' });
    return;
  }
  if (state.detailError) {
    mountBanner(body, {
      tone: 'error', title: 'Operation failed', body: state.detailError,
      action: { label: 'Retry', onClick: () => void loadDetail() },
    });
    return;
  }
  if (state.detailTab === 'terminal') {
    renderTerminal(body);
    return;
  }
  if (state.detailTab === 'events' || state.detailTab === 'instances') {
    if (!state.detailItems.length) {
      mountEmpty(body, { title: state.detailTab === 'events' ? 'No events' : 'No instances' });
    } else {
      mountList(body, { items: state.detailItems, ariaLabel: state.detailTab, onSelect: () => undefined });
    }
    return;
  }
  body.append(node('pre', 'output', state.detailText || 'No data.'));
}

function renderTerminal(body: HTMLElement): void {
  const selected = state.selected;
  if (!selected) return;
  body.append(node('p', 'hint', 'Run a one-off command via kubectl exec in /bin/sh in the first or selected container. The SDK does not support an interactive TTY.'));
  const form = node('div', 'terminal-form');
  const container = node('div');
  const command = node('div');
  const run = node('div');
  form.append(container, command, run);
  body.append(form);
  mountSelect(container, {
    label: 'Container', value: state.selectedContainer || null,
    options: (selected.containers ?? []).map((name) => ({ id: name, label: name })),
    onChange: (id) => { state.selectedContainer = id; },
  });
  mountTextField(command, {
    label: 'Command', value: state.command, placeholder: 'ls -la', mono: true,
    onChange: (value) => { state.command = value; },
  });
  const output = node('pre', 'output terminal-output', state.execOutput || 'Command output will appear here.');
  body.append(output);
  const runButton = mountButton(run, {
    label: 'Run', size: 'sm',
    onClick: () => {
      if (!state.command.trim()) {
        void host.toast({ kind: 'info', message: 'Enter a command' });
        return;
      }
      runButton.update({ loading: true });
      void request<{ code: number; text: string }>('POST', '/api/exec', undefined, {
        ...baseQuery(), namespace: selected.namespace, pod: selected.name,
        container: state.selectedContainer, command: state.command,
      }).then((result) => {
        state.execOutput = result.text;
        output.textContent = result.text;
      }).catch((error) => {
        state.execOutput = errorText(error);
        output.textContent = state.execOutput;
      }).finally(() => runButton.update({ loading: false }));
    },
  });
}

function renderPorts(): void {
  const form = node('div', 'port-form');
  const target = node('div');
  const local = node('div');
  const remote = node('div');
  const start = node('div');
  form.append(target, local, remote, start);
  content.append(form);
  mountSelect(target, {
    label: 'Pod or Service', value: state.portTarget || null, options: state.portTargets, searchable: true,
    disabled: !state.portTargets.length,
    onChange: (id) => {
      state.portTarget = id;
      const selected = state.portTargets.find((item) => item.id === id);
      state.remotePort = String(selected?.ports[0] ?? 80);
      remoteField.update({ value: state.remotePort });
    },
  });
  mountTextField(local, {
    label: 'Local port', value: state.localPort, mono: true,
    onChange: (value) => { state.localPort = value; },
  });
  const remoteField = mountTextField(remote, {
    label: 'Remote port', value: state.remotePort, mono: true,
    onChange: (value) => { state.remotePort = value; },
  });
  const startButton = mountButton(start, {
    label: 'Start', size: 'sm', disabled: !state.portTarget,
    onClick: () => {
      startButton.update({ loading: true });
      void request<{ item: ResourceItem }>('POST', '/api/ports', undefined, {
        ...baseQuery(), target: state.portTarget, localPort: Number(state.localPort), remotePort: Number(state.remotePort),
      }).then((result) => {
        state.selectedPortId = result.item.id;
        void host.toast({ kind: 'success', message: `Available at localhost:${result.item.localPort}` });
        return loadContent();
      }).catch((error) => {
        void host.toast({ kind: 'error', message: errorText(error) });
      }).finally(() => startButton.update({ loading: false }));
    },
  });
  if (!state.portTargets.length) {
    mountBanner(content, { tone: 'info', title: 'No available targets', body: 'No Pods or Services were found in the cluster.' });
  }
  const items = filteredItems();
  const list = node('div');
  content.append(list);
  if (!items.length) {
    mountEmpty(list, { title: 'No active port-forwards', body: 'Select a target and ports above.' });
  } else {
    mountList(list, {
      items, selectedId: state.selectedPortId, ariaLabel: 'Active port-forwards',
      onSelect: (id) => { state.selectedPortId = id; renderContent(); },
    });
  }
  const selected = state.items.find((item) => item.id === state.selectedPortId);
  if (selected) {
    const row = node('div', 'port-detail');
    const text = node('div', 'port-detail-text', `http://127.0.0.1:${selected.localPort} → ${selected.target}`);
    const open = node('span');
    const stop = node('span');
    row.append(text, open, stop);
    content.append(row);
    mountButton(open, { label: 'Open', size: 'sm', variant: 'outline', onClick: () => void host.openUrl(`http://127.0.0.1:${selected.localPort}`) });
    mountButton(stop, {
      label: 'Stop', size: 'sm', variant: 'destructive',
      onClick: () => {
        void request('POST', '/api/ports/stop', undefined, { id: selected.id }).then(() => {
          state.selectedPortId = '';
          void host.toast({ kind: 'success', message: 'Port-forward stopped' });
          return loadContent();
        }).catch((error) => host.toast({ kind: 'error', message: errorText(error) }));
      },
    });
  }
}

for (const group of NAV) {
  const wrapper = node('div', 'nav-group');
  wrapper.append(node('div', 'nav-title', group.label));
  const list = node('div');
  wrapper.append(list);
  sidebar.append(wrapper);
  navHandles.push(mountList(list, {
    items: group.items.map((item) => ({ id: item.id, title: item.label })),
    selectedId: state.section,
    ariaLabel: group.label,
    onSelect: (id) => {
      if (id === state.section) return;
      detailSequence += 1;
      state.section = id;
      state.search = '';
      state.items = [];
      state.selected = null;
      state.selectedPortId = '';
      state.detailText = '';
      state.detailItems = [];
      detail.hidden = true;
      searchField.update({ value: '' });
      renderChrome();
      renderDetail();
      void loadContent();
    },
  }));
}

contextSelect = mountSelect(root.querySelector('#context')!, {
  value: null, options: [], placeholder: 'Kubernetes context', searchable: true, disabled: true,
  onChange: (id) => {
    if (id !== state.context) void initialize(id);
  },
});

namespaceSelect = mountSelect(root.querySelector('#namespace')!, {
  value: 'all', options: [{ id: 'all', label: 'All namespaces' }], searchable: true,
  onChange: (id) => {
    state.namespace = id;
    state.selected = null;
    detailSequence += 1;
    renderChrome();
    renderDetail();
    void loadContent();
  },
});

searchField = mountSearchField(root.querySelector('#search')!, {
  value: '', placeholder: 'Find a resource…', label: 'Resource search',
  onChange: (value) => { state.search = value; renderContent(); },
});

refreshButton = mountButton(root.querySelector('#refresh')!, {
  label: 'Refresh', variant: 'outline', size: 'sm',
  onClick: () => {
    refreshButton.update({ loading: true });
    void loadContent().finally(() => refreshButton.update({ loading: false }));
  },
});

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (state.ready || state.loading || state.contexts.length) return;
  void initialize();
});
