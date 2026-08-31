# Integration

The launcher and DeepSeek Harness communicate only through an approved,
versioned desktop bridge. Electron does not import Harness application packages,
mount Cordis, parse Session files, or emulate Harness business APIs.

Before an exact Harness runtime is ready, the renderer has only the bootstrap
information API. The future bridge must preserve the selected runtime
generation, request identity, cancellation, and sender admission rules from the
active OpenSpec.
