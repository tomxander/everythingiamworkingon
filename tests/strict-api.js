// A fake Messages API that enforces the request rules the real API enforces, and answers the way current models do:
// a signed thinking block with every reply, and tool calls whenever tools are offered. Every violation is recorded.
import http from 'node:http';

export function validate(body) {
  const errs = []; const msgs = body.messages || [];
  const hasToolBlocks = msgs.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_use' || c.type === 'tool_result'));
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) errs.push('max_tokens must be a positive integer');
  if (!msgs.length || msgs[0].role !== 'user') errs.push('first message must be from the user');
  msgs.forEach((m, i) => { if (i && m.role === msgs[i - 1].role) errs.push(`messages.${i}: roles must alternate`); });
  if (hasToolBlocks && !body.tools?.length) errs.push('Requests which include `tool_use` or `tool_result` blocks must define tools.');
  if (body.tool_choice && !['auto', 'any', 'tool', 'none'].includes(body.tool_choice.type)) errs.push('tool_choice.type is invalid');
  for (const t of body.tools || []) { if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) errs.push(`tool name ${t.name} is invalid`); if (t.input_schema?.type !== 'object') errs.push(`tool ${t.name}: input_schema.type must be object`); }
  msgs.forEach((m, i) => {
    if (typeof m.content === 'string') { if (!m.content.length) errs.push(`messages.${i}: content must be non-empty`); return; }
    if (!Array.isArray(m.content) || !m.content.length) errs.push(`messages.${i}: content must be a non-empty array`);
    m.content.forEach((c, j) => {
      if (c.type === 'thinking' || c.type === 'redacted_thinking') errs.push(`messages.${i}.content.${j}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.`);
      if (c.type === 'text' && !c.text) errs.push(`messages.${i}.content.${j}: text content blocks must be non-empty`);
    });
    if (m.role === 'assistant') {
      const uses = m.content.filter?.((c) => c.type === 'tool_use').map((c) => c.id) || [];
      if (uses.length) {
        const next = msgs[i + 1]; const results = Array.isArray(next?.content) ? next.content.filter((c) => c.type === 'tool_result').map((c) => c.tool_use_id) : [];
        for (const id of uses) if (!results.includes(id)) errs.push(`messages.${i + 1}: tool_use ids were found without tool_result blocks immediately after: ${id}`);
      }
    }
  });
  const last = msgs[msgs.length - 1]; if (last?.role === 'assistant' && Array.isArray(last.content) && /\s$/.test(last.content.at(-1)?.text || '')) errs.push('final assistant content cannot end with trailing whitespace');
  return errs;
}

/** reply(body) -> final text for a conversation that is done calling tools. toolInput(name) -> input for a tool call. */
export async function strictApi({ reply, toolInput = () => ({}), toolRounds = 2 }) {
  const state = { requests: 0, violations: [], toolCalls: 0 };
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      const body = JSON.parse(b || '{}'); state.requests++; res.setHeader('content-type', 'application/json');
      const errs = validate(body);
      if (errs.length) { state.violations.push(...errs); res.statusCode = 400; return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: errs[0] } })); }
      const thinking = { type: 'thinking', thinking: 'Considering the request.', signature: `sig-${state.requests}` };
      const rounds = (body.messages || []).filter((m) => m.role === 'assistant').length;
      const canCall = body.tools?.length && body.tool_choice?.type !== 'none' && rounds < toolRounds;
      if (canCall) {
        const t = body.tools[state.toolCalls % body.tools.length]; state.toolCalls++;
        return res.end(JSON.stringify({ stop_reason: 'tool_use', usage: { input_tokens: 50, output_tokens: 20 }, content: [thinking, { type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: `tu_${state.requests}`, name: t.name, input: toolInput(t.name) }] }));
      }
      res.end(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 80, output_tokens: 60 }, content: [thinking, { type: 'text', text: reply(body) }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => { server.closeAllConnections?.(); server.close(); } };
}
