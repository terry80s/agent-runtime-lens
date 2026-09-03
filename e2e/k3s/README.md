# k3s Remote-SSH fixture

This fixture reproduces the important topology: desktop VS Code → Remote-SSH → a limited Linux Pod → VS Code Server and workspace extensions inside that Pod.

1. Replace `REPLACE_WITH_ONE_SSH_PUBLIC_KEY` in `pod.yaml` with a disposable test public key. Never put a private key in the manifest.
2. Run `kubectl apply -f pod.yaml` against the test k3s cluster.
3. Wait for `vscode-workspace` to become Ready and connect Remote-SSH to the k3s node on port `30222` as `developer`.
4. Open `/workspace`; VS Code installs its server and workspace extensions into the Pod on first connection.
5. Install Agent Runtime Lens and Cline in the remote extension host, then verify CPU is relative to `500m`, memory total is `512Mi`, and Pod storage limit is `1Gi`.

The container image must be pulled by the k3s node. Pin the image digest in a controlled environment. This is an isolated test fixture, not a production deployment template.
