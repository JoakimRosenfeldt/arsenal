# Laya runtime

This package contains the compiled `Agent` dependency graph from the official
[Laya TypeScript SDK](https://github.com/NandhaKishorM/laya/tree/4066d5d5fbf08b66c6757ddeedbd797bd7655bc0/laya-ts).
The source revision is `4066d5d5fbf08b66c6757ddeedbd797bd7655bc0`, and the upstream
package version is `0.1.0`. The six upstream modules are unmodified. Arsenal's
`index` exports only `Agent`, answer types, and helpers for checking token limits.

The worker loads an absolute local model directory through `Agent.load` and uses
`onnxruntime-node` on the CPU. The SDK includes its tokenizer. Python is needed
only to export the model during development. No browser runtime is installed.

The upstream SDK does not expose session disposal. Arsenal runs each request in
a child process and terminates it after completion or cancellation.

To regenerate the JavaScript and declarations with the repository's TypeScript
`5.9.3`, run these commands from the repository root:

```sh
npm ci
node vendor/laya/update.mjs
```

The update script downloads the six source modules and license from the pinned
revision, compiles them, and replaces this package's generated files. To update
the upstream source, change `revision` in `update.mjs` and the revision recorded
here, then regenerate and check local inference with the bundled model.

The upstream Apache 2.0 license is in [LICENSE](LICENSE).

The runtime bundle also includes ONNX Runtime's [MIT license](../onnxruntime-LICENSE)
and [third-party notices](../onnxruntime-ThirdPartyNotices.txt) from its
[1.23.2 release](https://github.com/microsoft/onnxruntime/tree/v1.23.2).
Arsenal pins that release because 1.24.3 omits Intel Mac binaries.
