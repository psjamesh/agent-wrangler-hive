export function testAgents() {
  return [
    { id: 'claude', available: true, efforts: [{ value: 'medium' }, { value: 'high' }], models: [{ value: 'opus', default: true, resolved: 'claude-opus-fixed' }, { value: 'sonnet', resolved: 'claude-sonnet-fixed' }] },
    { id: 'codex', available: true, efforts: [{ value: 'medium' }, { value: 'high' }], models: [{ value: 'gpt-6.1-sol', default: true, resolved: 'gpt-6.1-sol' }, { value: 'weak', resolved: 'weak' }] },
  ];
}
