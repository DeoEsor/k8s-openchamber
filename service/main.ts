import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

type K8sObject = Record<string, any>;
type ResourceSpec = { kind: string; apiKind: string; namespaced: boolean };
type Forward = {
  id: string;
  context: string;
  target: string;
  localPort: number;
  remotePort: number;
  createdAt: string;
  child: ChildProcess;
};

const RESOURCE_SPECS: Record<string, ResourceSpec> = {
  nodes: { kind: 'nodes', apiKind: 'Node', namespaced: false },
  events: { kind: 'events', apiKind: 'Event', namespaced: true },
  pods: { kind: 'pods', apiKind: 'Pod', namespaced: true },
  deployments: { kind: 'deployments', apiKind: 'Deployment', namespaced: true },
  statefulsets: { kind: 'statefulsets', apiKind: 'StatefulSet', namespaced: true },
  daemonsets: { kind: 'daemonsets', apiKind: 'DaemonSet', namespaced: true },
  jobs: { kind: 'jobs', apiKind: 'Job', namespaced: true },
  cronjobs: { kind: 'cronjobs', apiKind: 'CronJob', namespaced: true },
  services: { kind: 'services', apiKind: 'Service', namespaced: true },
  ingresses: { kind: 'ingresses', apiKind: 'Ingress', namespaced: true },
  pvc: { kind: 'persistentvolumeclaims', apiKind: 'PersistentVolumeClaim', namespaced: true },
  pv: { kind: 'persistentvolumes', apiKind: 'PersistentVolume', namespaced: false },
  storageclasses: { kind: 'storageclasses', apiKind: 'StorageClass', namespaced: false },
  configmaps: { kind: 'configmaps', apiKind: 'ConfigMap', namespaced: true },
  secrets: { kind: 'secrets', apiKind: 'Secret', namespaced: true },
  crds: { kind: 'customresourcedefinitions', apiKind: 'CustomResourceDefinition', namespaced: false },
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const forwards = new Map<string, Forward>();

function required(value: string | null, label: string): string {
  if (!value || value.length > 512) throw new HttpError(400, `Missing ${label}.`);
  return value;
}

function safeName(value: string | null, label = 'resource name'): string {
  const name = required(value, label);
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(name)) {
    throw new HttpError(400, `Invalid ${label}.`);
  }
  return name;
}

function namespaceFlag(namespace: string | null): string[] {
  if (!namespace || namespace === 'all') return ['--all-namespaces'];
  return ['--namespace', safeName(namespace, 'namespace')];
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(502, 'CLI returned an unreadable response.');
  }
}

function runResult(command: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      if (!settled) {
        settled = true;
        reject(new HttpError(504, `${command} did not respond within ${Math.round(timeoutMs / 1000)} s.`));
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length + stderr.length > 7_000_000) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stdout.length + stderr.length > 7_000_000) child.kill('SIGTERM');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new HttpError(503, error.code === 'ENOENT'
        ? `${command} was not found. Install it and check PATH.`
        : error.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function run(command: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const result = await runResult(command, args, timeoutMs);
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `${command} exited with code ${result.code}.`;
    throw new HttpError(502, message.slice(-6000));
  }
  return result.stdout;
}

function kubectl(context: string, args: string[], timeoutMs?: number): Promise<string> {
  return run('kubectl', ['--context', required(context, 'context'), ...args], timeoutMs);
}

function helm(context: string, args: string[], timeoutMs?: number): Promise<string> {
  return run('helm', ['--kube-context', required(context, 'context'), ...args], timeoutMs);
}

function age(value: string | undefined): string {
  if (!value) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function tone(status: string): 'neutral' | 'info' | 'success' | 'warning' | 'error' {
  if (/^(Running|Ready|Active|Bound|Available|deployed|Normal|Succeeded)$/i.test(status)) return 'success';
  if (/^(Failed|NotReady|Error|CrashLoopBackOff|ImagePullBackOff|Warning|Unhealthy)$/i.test(status)) return 'error';
  if (/^(Pending|Waiting|Terminating|Suspended|Progressing|unknown|superseded|uninstalled)$/i.test(status)) return 'warning';
  return 'neutral';
}

function readyCondition(item: K8sObject): string {
  const conditions = item.status?.conditions ?? [];
  const ready = conditions.find((condition: K8sObject) => condition.type === 'Ready');
  return ready?.status === 'True' ? 'Ready' : 'NotReady';
}

function normalizeResource(item: K8sObject, section: string, forcedKind?: string): K8sObject {
  const metadata = item.metadata ?? {};
  const spec = item.spec ?? {};
  const status = item.status ?? {};
  const name = metadata.name ?? '—';
  const namespace = metadata.namespace ?? '';
  const specInfo = RESOURCE_SPECS[section];
  let badge = '';
  let subtitle = namespace;
  let meta = age(metadata.creationTimestamp);

  if (section === 'nodes') {
    badge = readyCondition(item);
    const roles = Object.keys(metadata.labels ?? {})
      .filter((key) => key.startsWith('node-role.kubernetes.io/'))
      .map((key) => key.split('/')[1]).join(', ') || 'worker';
    subtitle = `${roles} · ${status.nodeInfo?.kubeletVersion ?? '—'}`;
  } else if (section === 'pods') {
    badge = status.phase ?? 'Unknown';
    const restarts = (status.containerStatuses ?? []).reduce((sum: number, container: K8sObject) => sum + (container.restartCount ?? 0), 0);
    subtitle = `${namespace} · ${spec.nodeName ?? 'no node'} · restarts ${restarts}`;
  } else if (section === 'events') {
    badge = item.type ?? 'Normal';
    subtitle = `${namespace ? `${namespace}/` : ''}${item.involvedObject?.name ?? name} · ${item.message ?? item.reason ?? ''}`;
    meta = age(item.lastTimestamp ?? item.eventTime ?? metadata.creationTimestamp);
  } else if (['deployments', 'statefulsets', 'daemonsets'].includes(section)) {
    const desired = spec.replicas ?? status.desiredNumberScheduled ?? 0;
    const ready = status.readyReplicas ?? status.numberReady ?? 0;
    badge = desired === ready ? 'Ready' : 'Progressing';
    subtitle = `${namespace} · ${ready}/${desired} ready`;
  } else if (section === 'jobs') {
    badge = status.failed ? 'Failed' : status.succeeded ? 'Succeeded' : 'Active';
    subtitle = `${namespace} · ${status.succeeded ?? 0} succeeded · ${status.failed ?? 0} failed`;
  } else if (section === 'cronjobs') {
    badge = spec.suspend ? 'Suspended' : 'Active';
    subtitle = `${namespace} · ${spec.schedule ?? '—'}`;
  } else if (section === 'services') {
    badge = spec.type ?? 'ClusterIP';
    const ports = (spec.ports ?? []).map((port: K8sObject) => `${port.port}/${port.protocol ?? 'TCP'}`).join(', ');
    subtitle = `${namespace} · ${spec.clusterIP ?? '—'} · ${ports}`;
  } else if (section === 'ingresses') {
    const hosts = (spec.rules ?? []).flatMap((rule: K8sObject) => rule.host ? [rule.host] : []).join(', ');
    badge = 'Ingress';
    subtitle = `${namespace} · ${hosts || 'no host'}`;
  } else if (section === 'pvc' || section === 'pv') {
    badge = status.phase ?? 'Unknown';
    subtitle = `${namespace ? `${namespace} · ` : ''}${status.capacity?.storage ?? spec.resources?.requests?.storage ?? '—'} · ${spec.storageClassName ?? 'default'}`;
  } else if (section === 'storageclasses') {
    badge = metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? 'Default' : 'StorageClass';
    subtitle = item.provisioner ?? '—';
  } else if (section === 'configmaps' || section === 'secrets') {
    badge = section === 'secrets' ? (item.type ?? 'Secret') : 'ConfigMap';
    subtitle = `${namespace} · ${Object.keys(item.data ?? {}).length} keys`;
  } else if (section === 'crds') {
    badge = spec.scope ?? 'Cluster';
    subtitle = `${spec.group ?? '—'} · ${(spec.names ?? {}).kind ?? name}`;
  } else if (section === 'custom') {
    badge = forcedKind ?? 'Custom';
    subtitle = namespace || 'cluster-scoped';
  } else {
    badge = specInfo?.apiKind ?? forcedKind ?? 'Resource';
  }

  return {
    id: metadata.uid ?? `${namespace}/${name}`,
    name,
    namespace,
    kind: specInfo?.apiKind ?? forcedKind ?? item.kind ?? 'Resource',
    title: section === 'events' ? (item.reason ?? name) : name,
    subtitle: subtitle.replace(/\s+/g, ' ').slice(0, 240),
    meta,
    badge: badge ? { label: badge, tone: tone(badge) } : undefined,
    containers: section === 'pods' ? (spec.containers ?? []).map((container: K8sObject) => container.name) : undefined,
    customKind: section === 'crds' ? spec.names?.kind : undefined,
    scope: section === 'crds' ? spec.scope : undefined,
  };
}

async function listResources(url: URL): Promise<K8sObject> {
  const context = required(url.searchParams.get('context'), 'context');
  const section = required(url.searchParams.get('section'), 'section');
  const spec = RESOURCE_SPECS[section];
  if (!spec) throw new HttpError(404, 'Unknown section.');
  const namespaceArgs = spec.namespaced ? namespaceFlag(url.searchParams.get('namespace')) : [];
  const text = await kubectl(context, ['get', spec.kind, ...namespaceArgs, '-o', 'json'], 30_000);
  const list = parseJson<K8sObject>(text);
  return { items: (list.items ?? []).map((item: K8sObject) => normalizeResource(item, section)) };
}

async function contexts(url: URL): Promise<K8sObject> {
  const raw = await run('kubectl', ['config', 'view', '-o', 'json']);
  const config = parseJson<K8sObject>(raw);
  const list = config.contexts ?? [];
  const current = config['current-context'] ?? list[0]?.name;
  const context = url.searchParams.get('context') || current;
  if (!context) throw new HttpError(404, 'No contexts found in kubeconfig.');
  if (!list.some((item: K8sObject) => item.name === context)) throw new HttpError(404, 'Context not found in kubeconfig.');
  const namespacesText = await kubectl(context, ['get', 'namespaces', '-o', 'json'], 15_000);
  const namespaces = parseJson<K8sObject>(namespacesText);
  return {
    contexts: list.map((item: K8sObject) => ({
      id: item.name,
      label: item.name,
      hint: item.context?.cluster ?? '',
      namespace: item.context?.namespace ?? '',
    })),
    context,
    namespaces: (namespaces.items ?? []).map((item: K8sObject) => item.metadata.name).sort(),
  };
}

async function overview(url: URL): Promise<K8sObject> {
  const context = required(url.searchParams.get('context'), 'context');
  const [nodesText, podsText, eventsText] = await Promise.all([
    kubectl(context, ['get', 'nodes', '-o', 'json'], 30_000),
    kubectl(context, ['get', 'pods', '--all-namespaces', '-o', 'json'], 30_000),
    kubectl(context, ['get', 'events', '--all-namespaces', '-o', 'json'], 30_000),
  ]);
  const nodes = parseJson<K8sObject>(nodesText).items ?? [];
  const pods = parseJson<K8sObject>(podsText).items ?? [];
  const events = parseJson<K8sObject>(eventsText).items ?? [];
  const warnings = events
    .filter((item: K8sObject) => item.type === 'Warning')
    .sort((a: K8sObject, b: K8sObject) => String(b.lastTimestamp ?? '').localeCompare(String(a.lastTimestamp ?? '')))
    .slice(0, 12)
    .map((item: K8sObject) => normalizeResource(item, 'events'));
  return {
    stats: [
      { label: 'Nodes', value: `${nodes.filter((item: K8sObject) => readyCondition(item) === 'Ready').length}/${nodes.length}` },
      { label: 'Pods', value: String(pods.length) },
      { label: 'Running', value: String(pods.filter((item: K8sObject) => item.status?.phase === 'Running').length) },
      { label: 'Issues', value: String(pods.filter((item: K8sObject) => !['Running', 'Succeeded'].includes(item.status?.phase)).length) },
    ],
    version: nodes[0]?.status?.nodeInfo?.kubeletVersion ?? '—',
    warnings,
  };
}

async function yamlFor(url: URL): Promise<K8sObject> {
  const context = required(url.searchParams.get('context'), 'context');
  const section = required(url.searchParams.get('section'), 'section');
  const spec = RESOURCE_SPECS[section];
  if (!spec) throw new HttpError(404, 'Unknown section.');
  const name = safeName(url.searchParams.get('name'));
  const namespace = url.searchParams.get('namespace');
  const namespaceArgs = spec.namespaced ? ['--namespace', safeName(namespace, 'namespace')] : [];
  const raw = await kubectl(context, ['get', spec.kind, name, ...namespaceArgs, '-o', 'json']);
  const object = parseJson<K8sObject>(raw);
  if (section === 'secrets') {
    if (object.data) object.data = Object.fromEntries(Object.keys(object.data).map((key) => [key, '<redacted>']));
    if (object.stringData) object.stringData = Object.fromEntries(Object.keys(object.stringData).map((key) => [key, '<redacted>']));
  }
  return { text: YAML.stringify(object) };
}

async function logs(url: URL): Promise<K8sObject> {
  const context = required(url.searchParams.get('context'), 'context');
  const name = safeName(url.searchParams.get('name'));
  const namespace = safeName(url.searchParams.get('namespace'), 'namespace');
  const container = url.searchParams.get('container');
  const args = ['logs', name, '--namespace', namespace, '--tail=300', '--timestamps=true'];
  if (container) args.push('--container', safeName(container, 'container'));
  else args.push('--all-containers=true');
  const text = await kubectl(context, args, 25_000);
  return { text: text || 'No logs yet.' };
}

async function resourceEvents(url: URL): Promise<K8sObject> {
  const context = required(url.searchParams.get('context'), 'context');
  const name = safeName(url.searchParams.get('name'));
  const kind = required(url.searchParams.get('kind'), 'resource type');
  const namespace = url.searchParams.get('namespace');
  const args = ['get', 'events', '--all-namespaces', '-o', 'json'];
  const raw = await kubectl(context, args);
  const items = parseJson<K8sObject>(raw).items ?? [];
  const filtered = items.filter((item: K8sObject) => item.involvedObject?.name === name
    && item.involvedObject?.kind === kind
    && (!namespace || item.involvedObject?.namespace === namespace));
  filtered.sort((a: K8sObject, b: K8sObject) => String(b.lastTimestamp ?? '').localeCompare(String(a.lastTimestamp ?? '')));
  return { items: filtered.map((item: K8sObject) => normalizeResource(item, 'events')) };
}

async function helmList(url: URL): Promise<K8sObject> {
  const context = required(url.searchParams.get('context'), 'context');
  const namespace = url.searchParams.get('namespace');
  const raw = await helm(context, ['list', '--all-namespaces', '-o', 'json']);
  const releases = parseJson<K8sObject[]>(raw).filter((item) => !namespace || namespace === 'all' || item.namespace === namespace);
  return {
    items: releases.map((item) => ({
      id: `${item.namespace}/${item.name}`,
      name: item.name,
      namespace: item.namespace,
      kind: 'HelmRelease',
      title: item.name,
      subtitle: `${item.namespace} · ${item.chart}`,
      meta: `r${item.revision}`,
      badge: { label: item.status, tone: tone(item.status) },
    })),
  };
}

async function helmDetail(url: URL): Promise<K8sObject> {
  const context = required(url.searchParams.get('context'), 'context');
  const name = safeName(url.searchParams.get('name'));
  const namespace = safeName(url.searchParams.get('namespace'), 'namespace');
  const view = required(url.searchParams.get('view'), 'view');
  const args = view === 'manifest'
    ? ['get', 'manifest', name, '--namespace', namespace]
    : view === 'values'
      ? ['get', 'values', name, '--namespace', namespace, '--output', 'yaml']
      : view === 'history'
        ? ['history', name, '--namespace', namespace, '--output', 'yaml']
        : null;
  if (!args) throw new HttpError(404, 'Unknown Helm view.');
  return { text: await helm(context, args, 30_000) };
}

async function customResources(url: URL): Promise<K8sObject> {
  const context = required(url.searchParams.get('context'), 'context');
  const crd = safeName(url.searchParams.get('crd'), 'CRD');
  const scope = url.searchParams.get('scope');
  const kind = required(url.searchParams.get('kind'), 'CRD kind');
  const args = ['get', crd, ...(scope === 'Namespaced' ? ['--all-namespaces'] : []), '-o', 'json'];
  const raw = await kubectl(context, args, 30_000);
  const object = parseJson<K8sObject>(raw);
  const items = object.items ?? (object.metadata ? [object] : []);
  return { items: items.map((item: K8sObject) => normalizeResource(item, 'custom', kind)) };
}

async function execCommand(body: K8sObject): Promise<K8sObject> {
  const context = required(body.context, 'context');
  const namespace = safeName(body.namespace, 'namespace');
  const pod = safeName(body.pod, 'pod name');
  const container = safeName(body.container, 'container');
  const command = required(body.command, 'command');
  if (command.length > 4000) throw new HttpError(400, 'Command is too long.');
  const result = await runResult('kubectl', [
    '--context', context, 'exec', pod, '--namespace', namespace, '--container', container,
    '--', '/bin/sh', '-c', command,
  ], 30_000);
  return { code: result.code, text: [result.stdout, result.stderr].filter(Boolean).join('\n') || 'Command completed without output.' };
}

async function portTargets(url: URL): Promise<K8sObject> {
  const context = required(url.searchParams.get('context'), 'context');
  const [podsText, servicesText] = await Promise.all([
    kubectl(context, ['get', 'pods', '--all-namespaces', '-o', 'json']),
    kubectl(context, ['get', 'services', '--all-namespaces', '-o', 'json']),
  ]);
  const pods = parseJson<K8sObject>(podsText).items ?? [];
  const services = parseJson<K8sObject>(servicesText).items ?? [];
  const podTargets = pods.flatMap((item: K8sObject) => {
    const ports = (item.spec?.containers ?? []).flatMap((container: K8sObject) => container.ports ?? []).map((port: K8sObject) => port.containerPort);
    return [{ id: `pod/${item.metadata.namespace}/${item.metadata.name}`, label: `Pod · ${item.metadata.namespace}/${item.metadata.name}`, ports }];
  });
  const serviceTargets = services.map((item: K8sObject) => ({
    id: `service/${item.metadata.namespace}/${item.metadata.name}`,
    label: `Service · ${item.metadata.namespace}/${item.metadata.name}`,
    ports: (item.spec?.ports ?? []).map((port: K8sObject) => port.port),
  }));
  return { items: [...serviceTargets, ...podTargets] };
}

function publicForward(forward: Forward): K8sObject {
  return {
    id: forward.id,
    title: `:${forward.localPort} → :${forward.remotePort}`,
    subtitle: forward.target,
    meta: age(forward.createdAt),
    badge: { label: 'Active', tone: 'success' },
    localPort: forward.localPort,
    target: forward.target,
  };
}

async function startForward(body: K8sObject): Promise<K8sObject> {
  const context = required(body.context, 'context');
  const target = required(body.target, 'target');
  const match = /^(pod|service)\/([a-z0-9.-]+)\/([a-z0-9.-]+)$/i.exec(target);
  if (!match) throw new HttpError(400, 'Invalid port-forward target.');
  const localPort = Number(body.localPort);
  const remotePort = Number(body.remotePort);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535
    || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new HttpError(400, 'Ports must be integers from 1 to 65535.');
  }
  if ([...forwards.values()].some((item) => item.localPort === localPort)) {
    throw new HttpError(409, `Local port ${localPort} is already in use by this extension.`);
  }
  const [, type, namespace, name] = match;
  const id = randomUUID();
  const child = spawn('kubectl', [
    '--context', context, 'port-forward', '--namespace', namespace!, `${type}/${name}`, `${localPort}:${remotePort}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const forward: Forward = { id, context, target, localPort, remotePort, createdAt: new Date().toISOString(), child };
  forwards.set(id, forward);
  let output = '';
  const capture = (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-4000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', () => forwards.delete(id));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      forwards.delete(id);
      child.kill('SIGTERM');
      reject(new HttpError(504, `Port-forward failed to start. ${output.slice(-2000)}`));
    }, 15_000);
    const check = () => {
      if (output.includes('Forwarding from')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      forwards.delete(id);
      reject(new HttpError(503, error.code === 'ENOENT' ? 'kubectl was not found.' : error.message));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      forwards.delete(id);
      reject(new HttpError(502, `Port-forward stopped (code ${code}). ${output.slice(-2000)}`));
    });
  });
  return { item: publicForward(forward) };
}

function stopForward(body: K8sObject): K8sObject {
  const id = required(body.id, 'port-forward');
  const forward = forwards.get(id);
  if (!forward) throw new HttpError(404, 'Port-forward is already stopped.');
  forwards.delete(id);
  forward.child.kill('SIGTERM');
  return { stopped: true };
}

async function route(method: string, url: URL, body: K8sObject): Promise<K8sObject> {
  const path = url.pathname;
  if (method === 'GET' && path === '/api/bootstrap') return contexts(url);
  if (method === 'GET' && path === '/api/overview') return overview(url);
  if (method === 'GET' && path === '/api/resources') return listResources(url);
  if (method === 'GET' && path === '/api/yaml') return yamlFor(url);
  if (method === 'GET' && path === '/api/logs') return logs(url);
  if (method === 'GET' && path === '/api/events') return resourceEvents(url);
  if (method === 'GET' && path === '/api/helm') return helmList(url);
  if (method === 'GET' && path === '/api/helm-detail') return helmDetail(url);
  if (method === 'GET' && path === '/api/custom-resources') return customResources(url);
  if (method === 'GET' && path === '/api/port-targets') return portTargets(url);
  if (method === 'GET' && path === '/api/ports') return { items: [...forwards.values()].map(publicForward) };
  if (method === 'POST' && path === '/api/ports') return startForward(body);
  if (method === 'POST' && path === '/api/ports/stop') return stopForward(body);
  if (method === 'POST' && path === '/api/exec') return execCommand(body);
  throw new HttpError(404, 'Route not found.');
}

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    return;
  }
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk.toString();
    if (raw.length > 1_000_000) req.destroy();
  });
  req.on('end', () => {
    void (async () => {
      try {
        const body = raw ? parseJson<K8sObject>(raw) : {};
        const answer = await route(req.method ?? 'GET', url, body);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(answer));
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error ? error.message : 'Unknown error.';
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: message }));
      }
    })();
  });
});

function shutdown(): void {
  for (const forward of forwards.values()) forward.child.kill('SIGTERM');
  forwards.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.listen(port, '127.0.0.1');
