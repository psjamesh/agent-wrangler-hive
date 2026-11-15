import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

fs.mkdirSync('.scratch', { recursive: true });
const root = fs.mkdtempSync(path.resolve('.scratch/claude-resume-schema-'));
const toolName = 'mcp__probe__probe_tool';
const captures = [];
let version = 1, phase = 'fresh', sequence = 0;
console.log(JSON.stringify({
  cli: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
  node: process.version,
  artifacts: root,
}));

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

const mcp = http.createServer(async (req, res) => {
  if (req.method !== 'POST') return res.writeHead(405).end();
  const input = await body(req);
  let result;
  if (input.method === 'initialize') {
    result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } };
  } else if (input.method === 'tools/list') {
    const properties = { title: { type: 'string' } };
    if (version === 2) properties.options = { type: 'array', items: { type: 'string' } };
    result = { tools: [{
      name: 'probe_tool', description: 'Submit a probe request',
      inputSchema: { type: 'object', properties, required: ['title'], additionalProperties: false },
    }] };
    captures.push({ phase, boundary: 'tools/list', properties: Object.keys(properties) });
  } else if (input.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'ok' }] };
  } else {
    return res.writeHead(202).end();
  }
  res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
});

const api = http.createServer(async (req, res) => {
  if (!req.url.includes('/v1/messages')) {
    return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  }
  const input = await body(req);
  const tool = input.tools?.find(entry => entry.name === toolName);
  if (tool) captures.push({ phase, boundary: 'messages', properties: Object.keys(tool.input_schema.properties) });
  const search = sequence++ === 0;
  const content = search
    ? { type: 'tool_use', id: `toolu_${phase}`, name: 'ToolSearch', input: { query: `select:${toolName}`, max_results: 1 } }
    : { type: 'text', text: 'Capture complete.' };
  const message = {
    id: `msg_${phase}_${sequence}`, type: 'message', role: 'assistant', model: input.model,
    content: [content], stop_reason: search ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 },
  };
  if (!input.stream) {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  emit('message_start', { message: { ...message, content: [], stop_reason: null } });
  emit('content_block_start', { index: 0, content_block: search ? { ...content, input: {} } : { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: search
    ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
    : { type: 'text_delta', text: content.text } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  emit('message_stop', {});
  res.end();
});

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(mcp);
await listen(api);
fs.writeFileSync(`${root}/mcp.json`, JSON.stringify({ mcpServers: {
  probe: { type: 'http', url: `http://127.0.0.1:${mcp.address().port}/mcp` },
} }));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(AW_|CLAUDE|ANTHROPIC)/.test(key)) delete env[key];
}
Object.assign(env, {
  CLAUDE_CONFIG_DIR: `${root}/config`, ANTHROPIC_API_KEY: 'isolated-dummy-key',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'true',
});

async function run(extra = []) {
  sequence = 0;
  const child = spawn('claude', [
    '-p', '--model', 'haiku', '--output-format', 'json', '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', `${root}/mcp.json`,
    '--allowedTools', `ToolSearch,${toolName}`, '--max-turns', '3',
    ...extra, '--', 'Find probe_tool with ToolSearch.',
  ], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const timer = setTimeout(() => child.kill(), 45000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('exit', resolve);
      child.on('error', reject);
    });
    fs.writeFileSync(`${root}/${phase}.json`, output);
    fs.writeFileSync(`${root}/${phase}.err`, errors);
    assert.equal(code, 0, `${phase}: ${errors}`);
    const result = JSON.parse(output);
    assert.equal(result.is_error, false);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

try {
  const first = await run();
  version = 2;
  phase = 'resumed';
  await run(['--resume', first.session_id]);
  phase = 'fresh-v2';
  await run();

  const projects = `${root}/config/projects`;
  const project = fs.readdirSync(projects).find(dir => fs.existsSync(`${projects}/${dir}/${first.session_id}.jsonl`));
  const transcript = `${projects}/${project}/${first.session_id}.jsonl`;
  const lines = fs.readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse);
  let edited = 0;
  for (const line of lines) {
    if (line.attachment?.type !== 'deferred_tools_record') continue;
    for (const entry of line.attachment.entries) {
      if (entry.name !== toolName) continue;
      entry.input_schema.properties.snapshot_marker = { type: 'boolean' };
      edited++;
    }
  }
  assert.equal(edited, 1);
  fs.writeFileSync(transcript, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  phase = 'resumed-record-edited';
  await run(['--resume', first.session_id]);

  fs.writeFileSync(`${root}/summary.json`, JSON.stringify(captures, null, 2));
  const expected = {
    fresh: ['title'], resumed: ['title'], 'fresh-v2': ['title', 'options'],
    'resumed-record-edited': ['title', 'snapshot_marker'],
  };
  for (const [label, properties] of Object.entries(expected)) {
    const rows = captures.filter(row => row.phase === label && row.boundary === 'messages');
    assert.equal(rows.length, label.startsWith('resumed') ? 2 : 1);
    for (const row of rows) assert.deepEqual(row.properties, properties);
    const listed = captures.filter(row => row.phase === label && row.boundary === 'tools/list');
    assert.ok(listed.length > 0);
    for (const row of listed) assert.deepEqual(row.properties, label === 'fresh' ? ['title'] : ['title', 'options']);
  }
  for (const row of captures) console.log(JSON.stringify(row));
  console.log('Observed stale deferred schema on resume and persisted-record precedence. No remote model requests.');
} finally {
  api.close();
  mcp.close();
}
