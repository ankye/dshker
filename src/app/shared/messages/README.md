# Domain Messages

Use this folder for app-layer message contracts shared across domains.

Cross-domain communication should use:

- domain events for facts that already happened, such as
  `asset.imported` or `render.completed`
- commands for requests owned by another domain, such as
  `render.enqueue`
- queries only through explicit public APIs when a synchronous read is required

Do not import another domain's private store, repository, workflow, or component
to coordinate behavior. Use the domain's public `index.ts` or publish a typed
message through the app event bus.
