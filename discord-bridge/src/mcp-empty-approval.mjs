// The Desktop distinguishes tool approvals using this protocol metadata.
// An empty object alone is not proof that a request is an ordinary approval.
export function isEmptyMcpToolApproval(params) {
  if (params?.mode !== 'form'
    || params._meta?.codex_approval_kind !== 'mcp_tool_call'
    || typeof params._meta.tool_name !== 'string'
    || !params._meta.tool_name.trim()
    || Object.hasOwn(params._meta, 'openai/confirmation')) return false;
  const schema = params.requestedSchema;
  if (!schema || schema.type !== 'object'
    || !schema.properties || typeof schema.properties !== 'object'
    || Array.isArray(schema.properties)
    || Object.keys(schema.properties).length !== 0) return false;
  if (schema.required !== undefined
    && (!Array.isArray(schema.required) || schema.required.length !== 0)) return false;
  if (schema.additionalProperties !== undefined
    && typeof schema.additionalProperties !== 'boolean') return false;
  // Unknown constraints or composed schemas must retain the input workflow.
  const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema']);
  return Object.keys(schema).every((key) => supported.has(key));
}

export function emptyMcpToolApprovalResponse(params) {
  if (!isEmptyMcpToolApproval(params)) {
    throw new Error('This MCP request requires its original input or verification workflow.');
  }
  return { action: 'accept', content: {} };
}
