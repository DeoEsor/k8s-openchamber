# K8S for OpenChamber

Lens-like Kubernetes panel for OpenChamber. Uses the local `kubectl`, `helm`, kubeconfig and current user's permissions; Lens.app is not required.

## Features

- Context and namespace switching.
- Cluster overview, nodes and events.
- Pods, Deployments, StatefulSets, DaemonSets, Jobs and CronJobs.
- Services, Ingresses, storage, ConfigMaps and Secrets.
- Resource events and YAML. Secret `data` / `stringData` values are redacted.
- Pod log snapshots and one-shot commands through `kubectl exec`.
- Helm releases, manifests, values and history.
- CRDs and custom resource instances.
- Managed `kubectl port-forward` processes.

The OpenChamber SDK 2.7.2 has no panel-to-service streaming call, so logs are snapshots and Terminal executes one command at a time rather than opening an interactive TTY.

## Requirements

- OpenChamber 2.7.2 or later.
- `kubectl` and a working kubeconfig.
- `helm` for Helm release support.
- Bun for development and builds.

## Install

1. Clone this repository.
2. Run `bun install && bun run build` in the project directory.
3. In OpenChamber, open **Settings → Extensions** and install the extension from the cloned directory.

## Build and check

```sh
bun install
bun run build
bun run check
```

The service listens on loopback only and keeps running so active port-forwards survive panel reloads. It stops them on service shutdown.
