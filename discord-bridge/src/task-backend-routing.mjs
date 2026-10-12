const backends = new Set(['shared', 'durable']);
const operations = new Set(['read', 'deliver', 'interrupt', 'archive', 'unarchive', 'rename']);

// Existing bindings belong to the shared server. Durable bindings must be
// explicitly registered; an unavailable durable adapter never falls back.
export function resolveTaskBackend(binding, threadId) {
  if (!binding || !threadId || binding.threadId !== threadId) {
    throw new Error('An exact registered task binding is required.');
  }
  const backend = binding.backend ?? 'shared';
  if (!backends.has(backend)) throw new Error('Unknown task backend.');
  if (backend === 'durable' && binding.hostId !== 'durable') {
    throw new Error('Durable task bindings require the durable host.');
  }
  if (backend === 'shared' && binding.hostId != null && binding.hostId !== 'local') {
    throw new Error('Shared task bindings require the local host.');
  }
  return backend;
}

export async function executeBoundTaskOperation({ binding, threadId, operation, adapters, args = [] }) {
  const backend = resolveTaskBackend(binding, threadId);
  if (!operations.has(operation)) throw new Error('Unsupported task operation.');
  if (!Array.isArray(args)) throw new Error('Task operation arguments must be an array.');
  const adapter = adapters?.[backend];
  if (!adapter || typeof adapter[operation] !== 'function') {
    throw new Error(`The ${backend} task backend does not support ${operation}.`);
  }
  return adapter[operation](threadId, ...args);
}
